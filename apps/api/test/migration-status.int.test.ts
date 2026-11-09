/**
 * Vérification des migrations au démarrage, sur de vraies bases : la base de test (à jour), et une base jetable
 * préparée à la main pour chaque cas (jamais migrée, droit de lecture absent, migrations en retard).
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationStatus, readJournal } from '../src/db/migration-status.js';

const SCRATCH = 'ziga_migcheck_test';

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

const statusAs = (url: string) => withClient(url, (c) => migrationStatus((sql) => c.query(sql), readJournal()));
const owner = () => urlFor(process.env.DATABASE_MIGRATION_URL!, SCRATCH);
const api = () => urlFor(process.env.DATABASE_URL!, SCRATCH);

async function recreateScratch(): Promise<void> {
	await withClient(urlFor(process.env.DATABASE_MIGRATION_URL!, 'postgres'), async (c) => {
		await c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
		await c.query(`CREATE DATABASE ${SCRATCH}`);
	});
}

/** Table des migrations telle que Drizzle la crée, remplie jusqu'à la migration `upTo` (incluse). */
async function recordMigrations(upTo: string, grant: boolean): Promise<void> {
	const journal = readJournal();
	const applied = journal.slice(0, journal.findIndex((e) => e.tag === upTo) + 1);
	await withClient(owner(), async (c) => {
		await c.query('CREATE SCHEMA drizzle');
		await c.query('CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)');
		for (const e of applied) await c.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', [e.tag, e.when]);
		if (grant) {
			await c.query('GRANT USAGE ON SCHEMA drizzle TO app_api');
			await c.query('GRANT SELECT ON drizzle.__drizzle_migrations TO app_api');
		}
	});
}

describe('migrations au démarrage, sur une vraie base', () => {
	beforeAll(recreateScratch);
	afterAll(async () => {
		await withClient(urlFor(process.env.DATABASE_MIGRATION_URL!, 'postgres'), (c) =>
			c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`)
		);
	});

	it('la base de test, migrée, est à jour pour app_api et app_admin', async () => {
		expect(await statusAs(process.env.DATABASE_URL!)).toEqual({ state: 'up_to_date' });
		expect(await statusAs(process.env.DATABASE_ADMIN_URL!)).toEqual({ state: 'up_to_date' });
	});

	it('une base jamais migrée', async () => {
		expect(await statusAs(api())).toEqual({ state: 'empty' });
	});

	it('une base arrêtée à 0004 : le droit de lecture manque, donc au moins 0005', async () => {
		await recreateScratch();
		await recordMigrations('0004_features_plans_admin', false);
		const status = await statusAs(api());
		expect(status).toMatchObject({ state: 'pending', atLeast: true });
		expect(status.state === 'pending' && status.tags[0]).toBe('0005_migration_status');
	});

	it('une base qui a le droit de lecture mais pas la dernière migration', async () => {
		const journal = readJournal();
		const beforeLast = journal[journal.length - 2]!.tag;
		await recreateScratch();
		await recordMigrations(beforeLast, true);
		expect(await statusAs(api())).toEqual({ state: 'pending', tags: [journal[journal.length - 1]!.tag], atLeast: false });
	});
});
