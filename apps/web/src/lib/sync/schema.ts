/**
 * Schéma de la base locale (PowerSync), construit depuis la description partagée `@ziga/shared/sync-schema`
 * (lot 05). Cette description est comparée par un test à celle que PowerSync déduit des Sync Streams : client et
 * serveur ne peuvent pas diverger sans qu'un test échoue. Voir docs/SYNC.md.
 */
import { column, Schema, Table } from '@powersync/web';
import { SYNCED_TABLES, type LocalColumnType } from '@ziga/shared/sync-schema';

const TYPES = { text: column.text, integer: column.integer, real: column.real } satisfies Record<LocalColumnType, unknown>;

function table(columns: Record<string, LocalColumnType>): Table {
	const indexes: Record<string, string[]> = 'organization_id' in columns ? { by_organization: ['organization_id'] } : {};
	return new Table(Object.fromEntries(Object.entries(columns).map(([name, type]) => [name, TYPES[type]])), { indexes });
}

export const AppSchema = new Schema(Object.fromEntries(Object.entries(SYNCED_TABLES).map(([name, columns]) => [name, table(columns)])));
