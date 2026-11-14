/**
 * Correction du lot 07 : la migration 0012 garantit que Tabtenga n'est qu'un quartier de Ouagadougou (réponse du
 * porteur), sur une base du lot 07 (CLAUDE.md §7). Base jetable migrée jusqu'à 0011, avec un « Tabtenga » ajouté à
 * Saaba (comme l'aurait fait le back-office), puis migrée jusqu'au bout. Un Tabtenga de Saaba référencé par un bien
 * n'est jamais supprimé.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '@ziga/shared/ids';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/migrate.js';

const SCRATCH = 'ziga_lot07_test';

function urlFor(base: string, database: string): string {
	const u = new URL(base);
	u.pathname = `/${database}`;
	return u.toString();
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
	const c = new pg.Client({ connectionString: url });
	await c.connect();
	try {
		return await fn(c);
	} finally {
		await c.end();
	}
}

const server = () => urlFor(process.env.DATABASE_MIGRATION_URL!, 'postgres');
const scratch = () => urlFor(process.env.DATABASE_MIGRATION_URL!, SCRATCH);

function foldersUpTo(lastTag: string): string {
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

/** Base du lot 07 avec un Tabtenga ajouté à Saaba ; `referenced` : un bien y est rattaché. */
async function lot07Base(referenced: boolean): Promise<string> {
	await withClient(server(), async (c) => {
		await c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
		await c.query(`CREATE DATABASE ${SCRATCH}`);
	});
	const folder = foldersUpTo('0011_geography_admin_insert');
	await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: folder }));
	rmSync(folder, { recursive: true, force: true });
	const tabtenga = newId();
	await withClient(scratch(), async (c) => {
		await c.query(`insert into neighborhoods (id, commune_id, name) values ($1, 'saaba', 'Tabtenga')`, [tabtenga]);
		if (!referenced) return;
		const user = newId();
		const org = newId();
		const ownerId = newId();
		await c.query(`insert into users (id, phone, name, password_hash, status) values ($1, '+22670555012', 'Directrice', 'x', 'active')`, [
			user
		]);
		await c.query('BEGIN');
		await c.query(`select set_config('app.organization_id', $1, true)`, [org]);
		await c.query(
			`insert into organizations (id, type, legal_name, phone, commune, created_by) values ($1, 'agency', 'Agence de Saaba', '+22625300012', 'Saaba', $2)`,
			[org, user]
		);
		await c.query(`insert into owners (id, organization_id, type, name, phone) values ($1, $2, 'person', 'Propriétaire', '+22670555013')`, [
			ownerId,
			org
		]);
		await c.query(
			`insert into properties (id, organization_id, owner_id, type, name, commune_id, neighborhood_id) values ($1, $2, $3, 'house', 'Villa', 'saaba', $4)`,
			[newId(), org, ownerId, tabtenga]
		);
		await c.query('COMMIT');
	});
	return tabtenga;
}

const tabtengas = () =>
	withClient(scratch(), (c) =>
		c.query(`select commune_id from neighborhoods where geo_name_key(name) = 'tabtenga' order by commune_id`)
	).then((r) => r.rows.map((row) => row.commune_id as string));

describe('migration 0012 : Tabtenga à Ouagadougou seulement', () => {
	afterAll(async () => {
		await withClient(server(), (c) => c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`));
	});

	describe('Tabtenga ajouté à Saaba, sans bien rattaché', () => {
		beforeAll(() => lot07Base(false));
		it('avant : à Ouagadougou et à Saaba ; après : à Ouagadougou seulement, Saaba garde ses 27 villages', async () => {
			expect(await tabtengas()).toEqual(['ouagadougou', 'saaba']);
			await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: MIGRATIONS_FOLDER }));
			expect(await tabtengas()).toEqual(['ouagadougou']);
			const saaba = await withClient(scratch(), (c) => c.query(`select count(*)::int as n from neighborhoods where commune_id = 'saaba'`));
			expect(saaba.rows[0].n).toBe(27);
		});
	});

	describe('Tabtenga de Saaba rattaché à un bien', () => {
		beforeAll(() => lot07Base(true));
		it('rien n’est supprimé : le bien garde son quartier (correction à la main)', async () => {
			await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: MIGRATIONS_FOLDER }));
			expect(await tabtengas()).toEqual(['ouagadougou', 'saaba']);
		});
	});
});
