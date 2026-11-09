/**
 * Vérifie les Sync Streams (infra/powersync/sync-config.yaml) avec le moteur de PowerSync lui-même
 * (@powersync/service-sync-rules, même version que le service) contre le schéma réel de la base :
 * syntaxe, colonnes et tables existantes. Écrit en JSON : erreurs et avertissements, tables lues.
 *
 * Lancé par test/sync-streams.int.test.ts, avec `--js-explicit-resource-management` : le moteur utilise
 * `using`, que Node 22 n'accepte qu'avec ce drapeau.
 *   node --js-explicit-resource-management scripts/check-sync-config.mjs <url-postgres> [fichier.yaml]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSyncConfig, StaticSchema, validateSyncConfig } from '@powersync/service-sync-rules';
import pg from 'pg';

const [url, file = resolve(import.meta.dirname, '../../../infra/powersync/sync-config.yaml')] = process.argv.slice(2);
if (!url) throw new Error('Usage : check-sync-config.mjs <url-postgres> [fichier.yaml]');

const client = new pg.Client({ connectionString: url });
await client.connect();
const { rows } = await client.query(
	`select table_name, column_name, udt_name from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position`
);
await client.end();

const tables = new Map();
for (const r of rows) {
	if (!tables.has(r.table_name)) tables.set(r.table_name, []);
	tables.get(r.table_name).push({ name: r.column_name, pg_type: r.udt_name });
}
const schema = new StaticSchema([
	{ tag: 'default', schemas: [{ name: 'public', tables: [...tables].map(([name, columns]) => ({ name, columns })) }] }
]);
const yaml = readFileSync(file, 'utf8');
const options = { schema, defaultSchema: 'public' };
const problems = validateSyncConfig(yaml, options).map((e) => ({ type: e.type, message: e.message }));
const { config } = parseSyncConfig(yaml, options);
const sourceTables = [...new Set(config.getSourceTables().map((t) => t.tablePattern))].sort();
process.stdout.write(JSON.stringify({ problems, sourceTables }));
