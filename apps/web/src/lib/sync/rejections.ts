/**
 * Modifications non acceptées (lot 05, étape 4, docs/SYNC.md §6).
 * Une opération refusée par le serveur quitte la file (elle ne la bloque jamais) ; la synchronisation suivante remet
 * sur l'appareil la valeur du serveur. Pour que rien ne se perde en silence, chaque refus est gardé dans une table
 * locale de l'appareil (jamais envoyée, vidée à la déconnexion), avec ce qui avait été saisi et le motif du serveur.
 * Fonctions pures, testées ; l'écriture dans la base passe par `recordRejections`, et « J'ai compris » retire un refus
 * de la liste (`acknowledgeRejection`).
 */
import type { SyncOperation, SyncOperationResult } from '@ziga/shared/sync';

/** Table locale (PowerSync `localOnly`) : son identifiant est la clé d'idempotence de l'opération refusée. */
export const REJECTIONS_TABLE = 'sync_rejections';
export const REJECTION_COLUMNS = {
	organization_id: 'text',
	table_name: 'text',
	row_id: 'text',
	operation: 'text',
	/** Colonnes envoyées, en JSON. */
	data: 'text',
	code: 'text',
	message: 'text',
	rejected_at: 'text'
} as const;

export interface RejectionRow {
	id: string;
	organization_id: string | null;
	table_name: string;
	row_id: string;
	operation: string;
	data: string | null;
	code: string;
	message: string;
	rejected_at: string;
}

export interface Rejected {
	operation: SyncOperation;
	result: SyncOperationResult;
}

/** Lignes à garder pour les opérations refusées d'un envoi. */
export function rejectionRows(rejected: Rejected[], now: Date = new Date()): RejectionRow[] {
	return rejected.map(({ operation, result }) => ({
		id: operation.key,
		organization_id: result.organizationId ?? null,
		table_name: operation.table,
		row_id: operation.id,
		operation: operation.op,
		data: operation.data ? JSON.stringify(operation.data) : null,
		code: result.code ?? 'REJECTED',
		message: result.message ?? '',
		rejected_at: now.toISOString()
	}));
}

/** Champs saisis, dans l'ordre de l'envoi, avec leur valeur ; une valeur vide s'affiche comme telle. */
export function rejectedFields(row: Pick<RejectionRow, 'data'>): { column: string; value: string }[] {
	if (!row.data) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(row.data);
	} catch {
		return [];
	}
	if (!parsed || typeof parsed !== 'object') return [];
	return Object.entries(parsed as Record<string, unknown>).map(([column, value]) => ({
		column,
		value: value === null || value === undefined || value === '' ? '' : typeof value === 'string' ? value : JSON.stringify(value)
	}));
}

export interface RejectionNotice {
	count: number;
	message: string;
}

/** Notification d'un envoi : le nombre de refus et le motif du premier. */
export function noticeOf(rejected: Rejected[]): RejectionNotice | null {
	if (!rejected.length) return null;
	return { count: rejected.length, message: rejected[0]!.result.message ?? '' };
}

/** Écriture locale des refus ; un même refus reçu deux fois (rejeu) ne crée pas de doublon. */
export async function recordRejections(
	db: { writeTransaction<T>(fn: (tx: { execute(sql: string, params?: unknown[]): Promise<unknown> }) => Promise<T>): Promise<T> },
	rows: RejectionRow[]
): Promise<void> {
	if (!rows.length) return;
	const columns = ['id', ...Object.keys(REJECTION_COLUMNS)] as (keyof RejectionRow)[];
	await db.writeTransaction(async (tx) => {
		for (const row of rows) {
			await tx.execute(
				`INSERT OR REPLACE INTO ${REJECTIONS_TABLE} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
				columns.map((c) => row[c])
			);
		}
	});
}

/** « J'ai compris » : le refus quitte la liste de l'appareil (rien n'est envoyé au serveur). */
export async function acknowledgeRejection(db: { execute(sql: string, params?: unknown[]): Promise<unknown> }, id: string): Promise<void> {
	await db.execute(`DELETE FROM ${REJECTIONS_TABLE} WHERE id = ?`, [id]);
}
