import { describe, expect, it } from 'vitest';
import { localOrganizationLookup, localReceiptLookup, toOperations, type CrudEntry } from './upload';

const ORG = '0195f3a0-0000-7000-8000-00000000000a';

describe('opérations envoyées par le connecteur (lots 05 et 06)', () => {
	it('clé d’idempotence : base locale et numéro de l’opération', async () => {
		const [op] = await toOperations(
			[{ clientId: 7, op: 'PATCH', table: 'organizations', id: ORG, opData: { trade_name: 'X' } }],
			'base',
			async () => null
		);
		expect(op).toEqual({ key: 'base:7', op: 'PATCH', table: 'organizations', id: ORG, data: { trade_name: 'X' } });
	});

	it('PUT : l’organisation vient de la colonne envoyée, sans lecture locale', async () => {
		const reads: string[] = [];
		const [op] = await toOperations(
			[{ clientId: 1, op: 'PUT', table: 'owners', id: 'o1', opData: { organization_id: ORG, name: 'Issa' } }],
			'base',
			async (table) => {
				reads.push(table);
				return null;
			}
		);
		expect(op!.organizationId).toBe(ORG);
		expect(reads).toEqual([]);
	});

	it('PATCH d’une table d’organisation : l’organisation de la ligne est lue dans la base locale', async () => {
		const ops = await toOperations(
			[
				{ clientId: 2, op: 'PATCH', table: 'mandates', id: 'm1', opData: { exclusive: 1 } },
				{ clientId: 3, op: 'PATCH', table: 'owners', id: 'disparu', opData: { name: 'X' } }
			],
			'base',
			async (_table, id) => (id === 'm1' ? ORG : null)
		);
		expect(ops.map((o) => o.organizationId)).toEqual([ORG, undefined]);
	});

	it('lecture locale : seulement les tables d’organisation, jamais une autre', async () => {
		const queries: string[] = [];
		const lookup = localOrganizationLookup({
			getOptional: async <T>(sql: string) => {
				queries.push(sql);
				return { organization_id: ORG } as T;
			}
		});
		expect(await lookup('mandates', 'm1')).toBe(ORG);
		expect(await lookup('organizations', ORG)).toBeNull();
		expect(await lookup('ps_crud; DROP TABLE owners', 'x')).toBeNull();
		expect(queries).toEqual(['SELECT organization_id FROM mandates WHERE id = ?']);
	});

	it('une entrée sans données (DELETE) garde data à null', async () => {
		const entry: CrudEntry = { clientId: 4, op: 'DELETE', table: 'organizations', id: ORG, opData: null };
		expect((await toOperations([entry], 'b', async () => null))[0]).toMatchObject({ data: null });
	});

	it('lot 09 : un encaissement créé sur l’appareil part avec son reçu (numéro provisoire et jetons) ; rien d’autre ne le porte', async () => {
		const receipt = { id: 'r1', provisionalNumber: 'PROV-ABCDEF', verificationToken: 'v'.repeat(43), shareToken: 's'.repeat(43) };
		const asked: string[] = [];
		const ops = await toOperations(
			[
				{ clientId: 5, op: 'PUT', table: 'payments', id: 'p1', opData: { organization_id: ORG, amount: 80000 } },
				{ clientId: 6, op: 'PUT', table: 'owners', id: 'o1', opData: { organization_id: ORG, name: 'Issa' } }
			],
			'base',
			async () => null,
			async (id) => {
				asked.push(id);
				return receipt;
			}
		);
		expect(ops[0]).toMatchObject({ table: 'payments', receipt });
		expect(ops[1]).not.toHaveProperty('receipt');
		expect(asked).toEqual(['p1']);
	});

	it('lot 09 : le reçu est lu dans la table locale de l’appareil, par l’encaissement', async () => {
		const queries: unknown[][] = [];
		const lookup = localReceiptLookup({
			getOptional: async <T>(sql: string, params?: unknown[]) => {
				queries.push([sql, params]);
				return { id: 'r1', provisional_number: 'PROV-ABCDEF', verification_token: 'v', share_token: 's' } as T;
			}
		});
		expect(await lookup('p1')).toEqual({ id: 'r1', provisionalNumber: 'PROV-ABCDEF', verificationToken: 'v', shareToken: 's' });
		expect(queries).toEqual([
			['SELECT id, provisional_number, verification_token, share_token FROM receipt_drafts WHERE payment_id = ?', ['p1']]
		]);
	});
});
