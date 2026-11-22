/**
 * Jeu de démonstration (lot 10 ter, étape 3e ; CLAUDE.md §10), sur une base vide à lui (`ziga_seed_test`), créée et
 * migrée ici : la première partie (personnes, organisations, formules), puis les fiches, baux, encaissements, relevé,
 * décompte et liens, par l'API elle-même. Ensuite, l'espace de chacune des deux personnes a son contenu ; relancé, le
 * seed ne crée aucun doublon.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/env.js';
import { createDatabase, createPool } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrate.js';
import { DEMO_IDS, DEMO_OWNER, DEMO_TENANT, seedDemoRecords } from '../src/db/seed-records.js';
import { DEMO_ORGANIZATIONS, DEMO_PEOPLE, seedDemo } from '../src/db/seed.js';
import { Client, startApp, type TestApp } from './http.js';

const NAME = 'ziga_seed_test';
const PASSWORD = 'demo-de-test-seed';
const withDatabase = (url: string) => {
	const u = new URL(url);
	u.pathname = `/${NAME}`;
	return u.toString();
};
const env = {
	...process.env,
	DATABASE_URL: withDatabase(process.env.DATABASE_URL!),
	DATABASE_ADMIN_URL: withDatabase(process.env.DATABASE_ADMIN_URL!),
	DATABASE_SYNC_URL: withDatabase(process.env.DATABASE_SYNC_URL!),
	DATABASE_MIGRATION_URL: withDatabase(process.env.DATABASE_MIGRATION_URL!)
};
const phoneOf = (key: string) => DEMO_PEOPLE.find((p) => p.key === key)!.phone;

async function server(sql: (c: pg.Client) => Promise<void>) {
	const url = new URL(process.env.DATABASE_MIGRATION_URL!);
	url.pathname = '/postgres';
	const c = new pg.Client({ connectionString: url.toString() });
	await c.connect();
	try {
		await sql(c);
	} finally {
		await c.end();
	}
}

/** Première partie du seed (comme `pnpm db:seed`), puis les fiches et les liens. */
async function seedAll(): Promise<string[]> {
	const pool = createPool({ url: env.DATABASE_URL, max: 2, connectionTimeoutMs: 5_000, applicationName: 'ziga-seed-test' });
	const adminPool = createPool({ url: env.DATABASE_ADMIN_URL, max: 1, connectionTimeoutMs: 5_000, applicationName: 'ziga-seed-test' });
	try {
		await seedDemo(createDatabase(pool), PASSWORD, createDatabase(adminPool));
	} finally {
		await pool.end();
		await adminPool.end();
	}
	return (await seedDemoRecords(parseConfig(env), PASSWORD)).created;
}

let t: TestApp;
let first: string[];

beforeAll(async () => {
	await server(async (c) => {
		await c.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
		await c.query(`CREATE DATABASE ${NAME}`);
	});
	await runMigrations({
		migrationUrl: env.DATABASE_MIGRATION_URL,
		roleUrls: [env.DATABASE_URL, env.DATABASE_ADMIN_URL, env.DATABASE_SYNC_URL]
	});
	first = await seedAll();
	t = await startApp({
		DATABASE_URL: env.DATABASE_URL,
		DATABASE_ADMIN_URL: env.DATABASE_ADMIN_URL,
		DATABASE_SYNC_URL: env.DATABASE_SYNC_URL
	});
}, 180_000);

afterAll(async () => {
	await t?.close();
	await server((c) => c.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`).then(() => undefined));
});

async function signIn(key: string): Promise<Client> {
	const c = new Client(t.url, '198.51.100.40');
	const r = await c.call('POST', '/auth/login', { phone: phoneOf(key), password: PASSWORD });
	expect(r.status, JSON.stringify(r.body)).toBe(200);
	return c;
}

describe('Jeu de démonstration (lot 10 ter, étape 3e)', () => {
	it('sur une base vide : fiches, baux, encaissements, relevé, décompte et liens sont créés', () => {
		expect(first).toEqual(
			expect.arrayContaining([
				'bail terminé de Moussa Nikiéma (A)',
				'fin du bail par la tâche du jour (A)',
				'décompte proposé au locataire (A)',
				'reversement au propriétaire (A)',
				'bail en cours de Moussa Nikiéma (B)',
				'fiche et mandat du bailleur particulier'
			])
		);
	});

	it('le propriétaire voit ses trois organisations : deux agences et sa propre organisation de bailleur', async () => {
		const owner = await signIn(DEMO_OWNER);
		expect((await owner.call('GET', '/me/portal')).body).toEqual({ owner: true, tenant: false });
		const assets = await owner.call<{ organizations: { organizationId: string; managedBy: string; properties: unknown[] }[] }>(
			'GET',
			'/me/portal/owner/assets'
		);
		expect(assets.status).toBe(200);
		expect(assets.body.organizations.map((o) => [o.organizationId, o.managedBy]).sort()).toEqual(
			[
				[DEMO_ORGANIZATIONS[0]!.id, 'agency'],
				[DEMO_ORGANIZATIONS[1]!.id, 'agency'],
				[DEMO_ORGANIZATIONS[2]!.id, 'self']
			].sort()
		);
		for (const o of assets.body.organizations) expect(o.properties.length).toBeGreaterThan(0);
		const statements = await owner.call<{ organizationId: string; paidOut: number; net: number }[]>('GET', '/me/portal/owner/statements');
		expect(statements.body).toHaveLength(1);
		expect(statements.body[0]!.paidOut).toBe(statements.body[0]!.net);
		expect(statements.body[0]!.net).toBeGreaterThan(0);
	});

	it('le locataire voit ses deux baux : terminé dans A, avec son décompte proposé ; en cours dans B ; reçus des deux', async () => {
		const tenant = await signIn(DEMO_TENANT);
		expect((await tenant.call('GET', '/me/portal')).body).toEqual({ owner: false, tenant: true });
		const contracts = await tenant.call<{ leaseId: string; group: string }[]>('GET', '/me/portal/tenant/contracts');
		expect(contracts.body.map((c) => [c.leaseId, c.group]).sort()).toEqual(
			[
				[DEMO_IDS.a.lease, 'ended'],
				[DEMO_IDS.b.lease, 'in_force']
			].sort()
		);
		const deposits = await tenant.call<{ leaseId: string; settlement: { status: string } | null }[]>('GET', '/me/portal/tenant/deposits');
		expect(deposits.body.find((d) => d.leaseId === DEMO_IDS.a.lease)?.settlement?.status).toBe('proposed');
		const history = await tenant.call<{ items: { kind: string; organizationId: string }[] }>('GET', '/me/portal/tenant/history');
		const receipts = history.body.items.filter((i) => i.kind === 'receipt');
		expect(new Set(receipts.map((r) => r.organizationId))).toEqual(new Set([DEMO_ORGANIZATIONS[0]!.id, DEMO_ORGANIZATIONS[1]!.id]));
	});

	it('relancé, le seed ne crée rien : aucun doublon', async () => {
		const owner = new pg.Client({ connectionString: env.DATABASE_MIGRATION_URL });
		await owner.connect();
		const counts = async () =>
			(
				await owner.query(
					`select (select count(*) from owners)::int owners, (select count(*) from leases)::int leases,
					        (select count(*) from payments)::int payments, (select count(*) from receipts)::int receipts,
					        (select count(*) from owner_statements)::int statements, (select count(*) from owner_payouts)::int payouts,
					        (select count(*) from deposit_settlements)::int settlements, (select count(*) from person_links)::int links`
				)
			).rows[0];
		try {
			const before = await counts();
			expect(await seedAll()).toEqual([]);
			expect(await counts()).toEqual(before);
		} finally {
			await owner.end();
		}
	}, 120_000);
});
