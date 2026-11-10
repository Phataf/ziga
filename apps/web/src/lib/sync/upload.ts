/**
 * Opérations envoyées par le connecteur (lot 05, étape 3 ; lot 06) : clé d'idempotence (base locale et numéro de
 * l'opération), et organisation de la ligne. Un PATCH ne porte que les colonnes modifiées, jamais `organization_id` :
 * pour une table d'organisation, le connecteur la lit dans la base locale. Le serveur ne la croit pas sur parole
 * (membre actif, puis ligne cherchée sous la RLS de cette organisation). Fonction pure, testée.
 */
import { ORGANIZATION_SCOPED_TABLES } from '@ziga/shared/sync-schema';
import type { SyncOperation } from '@ziga/shared/sync';

export interface CrudEntry {
	clientId: number;
	op: SyncOperation['op'];
	table: string;
	id: string;
	opData?: Record<string, unknown> | null;
}

/** Organisation d'une ligne locale (null si la ligne n'existe plus sur l'appareil). */
export type OrganizationLookup = (table: string, id: string) => Promise<string | null>;

const SCOPED = new Set<string>(ORGANIZATION_SCOPED_TABLES);

export async function toOperations(entries: CrudEntry[], databaseId: string, organizationOf: OrganizationLookup): Promise<SyncOperation[]> {
	const operations: SyncOperation[] = [];
	for (const entry of entries) {
		const data = entry.opData ?? null;
		const column = data?.organization_id;
		const organizationId =
			typeof column === 'string' ? column : SCOPED.has(entry.table) ? await organizationOf(entry.table, entry.id) : null;
		operations.push({
			key: `${databaseId}:${entry.clientId}`,
			op: entry.op,
			table: entry.table,
			id: entry.id,
			data,
			...(organizationId ? { organizationId } : {})
		});
	}
	return operations;
}

/** Lecture de l'organisation d'une ligne dans la base locale ; seules les tables d'organisation sont lues. */
export function localOrganizationLookup(db: { getOptional<T>(sql: string, params?: unknown[]): Promise<T | null> }): OrganizationLookup {
	return async (table, id) => {
		if (!SCOPED.has(table)) return null;
		const row = await db.getOptional<{ organization_id: string | null }>(`SELECT organization_id FROM ${table} WHERE id = ?`, [id]);
		return row?.organization_id ?? null;
	};
}
