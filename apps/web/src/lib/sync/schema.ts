/**
 * Schéma de la base locale (PowerSync), construit depuis la description partagée `@ziga/shared/sync-schema`
 * (lot 05). Cette description est comparée par un test à celle que PowerSync déduit des Sync Streams : client et
 * serveur ne peuvent pas diverger sans qu'un test échoue. Voir docs/SYNC.md.
 */
import { column, Schema, Table } from '@powersync/web';
import { SYNCED_TABLES, type LocalColumnType } from '@ziga/shared/sync-schema';
import { RECEIPT_DRAFT_COLUMNS, RECEIPT_DRAFTS_TABLE } from '../payments/views';
import { REJECTION_COLUMNS, REJECTIONS_TABLE } from './rejections';

const TYPES = { text: column.text, integer: column.integer, real: column.real } satisfies Record<LocalColumnType, unknown>;

function table(columns: Record<string, LocalColumnType>): Table {
	const indexes: Record<string, string[]> = 'organization_id' in columns ? { by_organization: ['organization_id'] } : {};
	// Une mise à jour qui ne change rien ne crée pas d'opération à envoyer (étape 3).
	return new Table(Object.fromEntries(Object.entries(columns).map(([name, type]) => [name, TYPES[type]])), {
		indexes,
		ignoreEmptyUpdates: true
	});
}

/**
 * Tables de l'appareil seulement (`localOnly`) : jamais envoyées ni reçues, vidées avec le reste à la déconnexion
 * (`disconnectAndClear`). Ici : les modifications refusées par le serveur (étape 4), et les reçus créés sur l'appareil
 * avec leurs jetons (lot 09) : le connecteur les joint à l'envoi de l'encaissement ; ils restent sur l'appareil pour
 * réafficher le QR code et repartager le lien, même hors ligne.
 */
const localOnly = (columns: Record<string, LocalColumnType>, indexes: Record<string, string[]>) =>
	new Table(Object.fromEntries(Object.entries(columns).map(([name, type]) => [name, TYPES[type]])), { localOnly: true, indexes });

const LOCAL_ONLY_TABLES = {
	[REJECTIONS_TABLE]: localOnly(REJECTION_COLUMNS, { by_organization: ['organization_id'] }),
	[RECEIPT_DRAFTS_TABLE]: localOnly(RECEIPT_DRAFT_COLUMNS, { by_payment: ['payment_id'] })
};

export const AppSchema = new Schema({
	...Object.fromEntries(Object.entries(SYNCED_TABLES).map(([name, columns]) => [name, table(columns)])),
	...LOCAL_ONLY_TABLES
});
