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

/** Lot 09 : reçu créé avec un encaissement sur l'appareil (table locale), joint à l'envoi de cet encaissement. */
export type ReceiptLookup = (paymentId: string) => Promise<NonNullable<SyncOperation['receipt']> | null>;

const SCOPED = new Set<string>(ORGANIZATION_SCOPED_TABLES);

export async function toOperations(
	entries: CrudEntry[],
	databaseId: string,
	organizationOf: OrganizationLookup,
	receiptOf: ReceiptLookup = async () => null
): Promise<SyncOperation[]> {
	const operations: SyncOperation[] = [];
	for (const entry of entries) {
		const data = entry.opData ?? null;
		const column = data?.organization_id;
		const organizationId =
			typeof column === 'string' ? column : SCOPED.has(entry.table) ? await organizationOf(entry.table, entry.id) : null;
		// Un encaissement créé sur l'appareil part avec son reçu (numéro provisoire et jetons) : le serveur n'en garde que
		// l'empreinte des jetons.
		const receipt = entry.table === 'payments' && entry.op === 'PUT' ? await receiptOf(entry.id) : null;
		operations.push({
			key: `${databaseId}:${entry.clientId}`,
			op: entry.op,
			table: entry.table,
			id: entry.id,
			data,
			...(organizationId ? { organizationId } : {}),
			...(receipt ? { receipt } : {})
		});
	}
	return operations;
}

/** Reçu local d'un encaissement (table `receipt_drafts`). */
export function localReceiptLookup(db: { getOptional<T>(sql: string, params?: unknown[]): Promise<T | null> }): ReceiptLookup {
	return async (paymentId) => {
		const row = await db.getOptional<{ id: string; provisional_number: string; verification_token: string; share_token: string }>(
			`SELECT id, provisional_number, verification_token, share_token FROM receipt_drafts WHERE payment_id = ?`,
			[paymentId]
		);
		return row
			? { id: row.id, provisionalNumber: row.provisional_number, verificationToken: row.verification_token, shareToken: row.share_token }
			: null;
	};
}

/** Lecture de l'organisation d'une ligne dans la base locale ; seules les tables d'organisation sont lues. */
export function localOrganizationLookup(db: { getOptional<T>(sql: string, params?: unknown[]): Promise<T | null> }): OrganizationLookup {
	return async (table, id) => {
		if (!SCOPED.has(table)) return null;
		const row = await db.getOptional<{ organization_id: string | null }>(`SELECT organization_id FROM ${table} WHERE id = ?`, [id]);
		return row?.organization_id ?? null;
	};
}
