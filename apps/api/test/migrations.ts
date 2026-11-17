/**
 * Tests de migration (CLAUDE.md §7) : base jetable migrée jusqu'à une migration donnée, remplie, puis migrée jusqu'au
 * bout. Connexions du propriétaire du schéma.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { MIGRATIONS_FOLDER } from '../src/db/migrate.js';

export function urlFor(base: string, database: string): string {
	const u = new URL(base);
	u.pathname = `/${database}`;
	return u.toString();
}

export async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
	const c = new pg.Client({ connectionString: url });
	await c.connect();
	try {
		return await fn(c);
	} finally {
		await c.end();
	}
}

/** Base `postgres` du serveur de test (création et suppression des bases jetables). */
export const serverUrl = () => urlFor(process.env.DATABASE_MIGRATION_URL!, 'postgres');
export const scratchUrl = (name: string) => urlFor(process.env.DATABASE_MIGRATION_URL!, name);

/** Copie du dossier des migrations, arrêtée à `lastTag` (journal compris). À supprimer après usage. */
export function foldersUpTo(lastTag: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'ziga-migrations-'));
	cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
	const journalPath = join(dir, 'meta', '_journal.json');
	const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
	const keep = journal.entries.findIndex((e) => e.tag === lastTag);
	for (const e of journal.entries.slice(keep + 1)) rmSync(join(dir, `${e.tag}.sql`));
	journal.entries = journal.entries.slice(0, keep + 1);
	writeFileSync(journalPath, JSON.stringify(journal));
	return dir;
}

/** Dans le contexte d'une organisation (la RLS s'applique aussi au propriétaire des tables). */
export async function inOrganization<T>(c: pg.Client, organizationId: string, fn: () => Promise<T>, commit = true): Promise<T> {
	await c.query('BEGIN');
	await c.query(`select set_config('app.organization_id', $1, true)`, [organizationId]);
	try {
		const r = await fn();
		await c.query(commit ? 'COMMIT' : 'ROLLBACK');
		return r;
	} catch (error) {
		await c.query('ROLLBACK');
		throw error;
	}
}
