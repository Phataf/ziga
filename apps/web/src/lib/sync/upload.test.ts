import { describe, expect, it } from 'vitest';
import { localOrganizationLookup, toOperations, type CrudEntry } from './upload';

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
});
