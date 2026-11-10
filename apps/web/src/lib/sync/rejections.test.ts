import { describe, expect, it } from 'vitest';
import type { SyncOperation, SyncOperationResult } from '@ziga/shared/sync';
import { noticeOf, recordRejections, rejectedFields, rejectionRows, REJECTION_COLUMNS, REJECTIONS_TABLE } from './rejections';

const ORG = '0195f3a0-0000-7000-8000-000000000001';
const op = (key: string, data: Record<string, unknown> | null = { trade_name: 'Nom refusé' }): SyncOperation => ({
	key,
	op: 'PATCH',
	table: 'organizations',
	id: ORG,
	data
});
const refused = (key: string, extra: Partial<SyncOperationResult> = {}): SyncOperationResult => ({
	key,
	status: 'rejected',
	replayed: false,
	code: 'FORBIDDEN_ACTION',
	message: 'Votre rôle ne permet pas cette action.',
	organizationId: ORG,
	...extra
});

describe('modifications non acceptées (lot 05, étape 4)', () => {
	it('garde ce qui avait été saisi, le motif et l’organisation visée ; identifiant = clé de l’opération', () => {
		const now = new Date('2026-11-10T08:30:00Z');
		expect(rejectionRows([{ operation: op('base:1'), result: refused('base:1') }], now)).toEqual([
			{
				id: 'base:1',
				organization_id: ORG,
				table_name: 'organizations',
				row_id: ORG,
				operation: 'PATCH',
				data: '{"trade_name":"Nom refusé"}',
				code: 'FORBIDDEN_ACTION',
				message: 'Votre rôle ne permet pas cette action.',
				rejected_at: '2026-11-10T08:30:00.000Z'
			}
		]);
	});

	it('sans organisation déterminée par le serveur : rangée à part (aucune organisation)', () => {
		const [row] = rejectionRows([{ operation: op('base:2'), result: refused('base:2', { organizationId: undefined }) }]);
		expect(row!.organization_id).toBeNull();
	});

	it('liste les champs saisis, valeur vide comprise', () => {
		expect(rejectedFields({ data: '{"trade_name":"Nom","po_box":null,"ifu":""}' })).toEqual([
			{ column: 'trade_name', value: 'Nom' },
			{ column: 'po_box', value: '' },
			{ column: 'ifu', value: '' }
		]);
		expect(rejectedFields({ data: null })).toEqual([]);
		expect(rejectedFields({ data: 'pas du JSON' })).toEqual([]);
	});

	it('notification : nombre de refus et motif du premier ; rien si aucun refus', () => {
		expect(noticeOf([])).toBeNull();
		expect(
			noticeOf([
				{ operation: op('a:1'), result: refused('a:1') },
				{ operation: op('a:2'), result: refused('a:2', { message: 'Autre motif' }) }
			])
		).toEqual({ count: 2, message: 'Votre rôle ne permet pas cette action.' });
	});

	it('écrit dans la table locale, sans doublon au rejeu (INSERT OR REPLACE sur la clé)', async () => {
		const calls: { sql: string; params?: unknown[] }[] = [];
		const db = {
			writeTransaction: async <T>(fn: (tx: { execute(sql: string, params?: unknown[]): Promise<unknown> }) => Promise<T>) =>
				fn({ execute: async (sql: string, params?: unknown[]) => calls.push({ sql, params }) })
		};
		await recordRejections(db, rejectionRows([{ operation: op('k:1'), result: refused('k:1') }]));
		await recordRejections(db, []);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.sql).toMatch(new RegExp(`^INSERT OR REPLACE INTO ${REJECTIONS_TABLE} \\(id, `));
		expect(calls[0]!.params).toHaveLength(1 + Object.keys(REJECTION_COLUMNS).length);
		expect(calls[0]!.params![0]).toBe('k:1');
	});
});
