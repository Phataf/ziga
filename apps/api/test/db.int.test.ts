/**
 * Socle de la base (lot 01) : rôles, fonction d'isolement et transactions par organisation.
 * Ces tests tournent avec le rôle app_api, celui de l'API : jamais un superutilisateur.
 */
import { newId } from '@ziga/shared/ids';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createPool, withOrganization, withTransaction, type Database } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrate.js';

function env(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Variable manquante pour les tests : ${name}`);
	return value;
}
let pool: pg.Pool;
let db: Database;
const options = { statementTimeoutMs: 15_000 };

beforeAll(() => {
	// Une seule connexion : on vérifie que rien ne reste attaché à la connexion après la transaction.
	pool = createPool({ url: env('DATABASE_URL'), max: 1, connectionTimeoutMs: 5_000, applicationName: 'ziga-test' });
	db = createDatabase(pool);
});
afterAll(() => pool.end());

async function value(query: string): Promise<unknown> {
	const r = await pool.query(query);
	return Object.values(r.rows[0] as object)[0];
}

describe('rôles PostgreSQL', () => {
	it('app_api et app_admin n’ont ni BYPASSRLS ni droits de superutilisateur', async () => {
		const r = await pool.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean; rolcreaterole: boolean }>(
			`select rolname, rolbypassrls, rolsuper, rolcreaterole from pg_roles where rolname in ('app_api', 'app_admin') order by rolname`
		);
		expect(r.rows).toEqual([
			{ rolname: 'app_admin', rolbypassrls: false, rolsuper: false, rolcreaterole: false },
			{ rolname: 'app_api', rolbypassrls: false, rolsuper: false, rolcreaterole: false }
		]);
	});

	it('l’API se connecte bien avec le rôle app_api', async () => {
		expect(await value('select current_user')).toBe('app_api');
	});
});

describe('current_organization_id() et withOrganization', () => {
	it('vaut NULL hors d’une transaction d’organisation', async () => {
		expect(await value('select current_organization_id()')).toBeNull();
	});

	it('rend l’organisation visible dans la transaction, et absente en dehors', async () => {
		const organizationId = newId();
		const inside = await withOrganization(db, organizationId, options, async (tx) => {
			const r = await tx.execute<{ org: string | null; raw: string }>(
				sql`select current_organization_id()::text as org, current_setting('app.organization_id', true) as raw`
			);
			return r.rows[0];
		});
		expect(inside).toEqual({ org: organizationId, raw: organizationId });
		// Même connexion (pool de taille 1) : SET LOCAL n'a rien laissé derrière lui.
		expect(await value('select current_organization_id()')).toBeNull();
		expect(await value(`select coalesce(current_setting('app.organization_id', true), '')`)).toBe('');
	});

	it('n’ouvre pas deux organisations à la fois sur des transactions successives', async () => {
		const a = newId();
		const b = newId();
		const seen = [
			await withOrganization(
				db,
				a,
				options,
				async (tx) => (await tx.execute<{ o: string }>(sql`select current_organization_id()::text as o`)).rows[0]?.o
			),
			await withOrganization(
				db,
				b,
				options,
				async (tx) => (await tx.execute<{ o: string }>(sql`select current_organization_id()::text as o`)).rows[0]?.o
			)
		];
		expect(seen).toEqual([a, b]);
	});

	it('annule tout et ne laisse rien si la fonction échoue', async () => {
		await expect(
			withOrganization(db, newId(), options, async () => {
				throw new Error('échec métier');
			})
		).rejects.toThrow('échec métier');
		expect(await value('select current_organization_id()')).toBeNull();
	});

	it('refuse un identifiant d’organisation invalide, avant toute requête', async () => {
		await expect(withOrganization(db, "x'; drop table users; --", options, async () => 1)).rejects.toMatchObject({
			code: 'INVALID_ORGANIZATION'
		});
	});
});

describe('délai maximal des requêtes (SET LOCAL statement_timeout)', () => {
	it('interrompt une requête trop longue, sans toucher les transactions suivantes', async () => {
		await expect(withTransaction(db, { statementTimeoutMs: 200 }, (tx) => tx.execute(sql`select pg_sleep(2)`))).rejects.toMatchObject({
			cause: { code: '57014' }
		});
		const after = await withTransaction(
			db,
			options,
			async (tx) => (await tx.execute<{ t: string }>(sql`select current_setting('statement_timeout') as t`)).rows[0]?.t
		);
		expect(after).toBe('15s');
		expect(await value(`select current_setting('statement_timeout')`)).toBe('0');
	});
});

describe('migrations', () => {
	it('se rejouent sans erreur sur une base déjà migrée', async () => {
		await expect(
			runMigrations({ migrationUrl: env('DATABASE_MIGRATION_URL'), roleUrls: [env('DATABASE_URL'), env('DATABASE_ADMIN_URL')] })
		).resolves.toBeUndefined();
	});
});
