/**
 * Lot 05, étape 1 : rôle de réplication `app_sync`, publication `powersync` et jeton de synchronisation (D30).
 * - app_sync lit les tables publiées, et rien d'autre ; il n'écrit nulle part ; il n'a pas BYPASSRLS.
 * - GET /sync/credentials émet un jeton signé par la clé des jetons d'accès, vérifiable par le JWKS public,
 *   d'audience ziga-sync, de 5 minutes, sans liste d'organisations ; l'API ne l'accepte jamais.
 */
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, signedUp, startApp, type TestApp } from './http.js';
import { createOrg, sqlError, type Org } from './orgs.js';

/** Tables synchronisées (lots 05 et 06) : toute nouvelle table passe par docs/SYNC.md et par cette liste. */
const PUBLISHED = [
	'feature_overrides',
	'features',
	'mandate_scopes',
	'mandate_versions',
	'mandates',
	'organization_feature_settings',
	'organization_members',
	'organizations',
	'owners',
	'plan_features'
];

async function connect(url: string): Promise<pg.Client> {
	const c = new pg.Client({ connectionString: url });
	await c.connect();
	return c;
}

describe('rôle de réplication app_sync (D30)', () => {
	let sync: pg.Client;
	let owner: pg.Client;
	let t: TestApp;
	let a: Org;
	let b: Org;

	beforeAll(async () => {
		t = await startApp();
		a = await createOrg(t, 'agency', 'Agence A');
		b = await createOrg(t, 'agency', 'Agence B');
		sync = await connect(process.env.DATABASE_SYNC_URL!);
		owner = await connect(process.env.DATABASE_MIGRATION_URL!);
	});
	afterAll(async () => {
		await sync.end();
		await owner.end();
		await t.close();
	});

	it('réplication seulement : ni BYPASSRLS, ni superutilisateur, ni création de rôle ou de base', async () => {
		const r = await owner.query(
			`select rolreplication, rolbypassrls, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin from pg_roles where rolname = 'app_sync'`
		);
		expect(r.rows).toEqual([
			{ rolreplication: true, rolbypassrls: false, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin: true }
		]);
	});

	it('la publication « powersync » contient exactement les tables du lot, jamais toutes les tables', async () => {
		const pub = await owner.query(`select puballtables from pg_publication where pubname = 'powersync'`);
		expect(pub.rows).toEqual([{ puballtables: false }]);
		const tables = await owner.query(`select tablename from pg_publication_tables where pubname = 'powersync' order by tablename`);
		expect(tables.rows.map((r) => r.tablename)).toEqual(PUBLISHED);
	});

	it('app_sync lit exactement les tables publiées, et aucune autre', async () => {
		const grants = await owner.query(
			`select table_name, privilege_type from information_schema.role_table_grants where grantee = 'app_sync' order by table_name`
		);
		expect(grants.rows).toEqual(PUBLISHED.map((table_name) => ({ table_name, privilege_type: 'SELECT' })));
	});

	it('chaque table publiée à RLS a sa politique de lecture explicite pour app_sync', async () => {
		const r = await owner.query(
			`select c.relname, exists (
				select from pg_policies p where p.tablename = c.relname and p.policyname = 'sync_read'
					and p.cmd = 'SELECT' and p.roles = '{app_sync}'
			) as has_policy
			from pg_class c join pg_publication_tables t on t.tablename = c.relname and t.pubname = 'powersync'
			where c.relrowsecurity order by c.relname`
		);
		expect(r.rows.length).toBeGreaterThan(0);
		for (const row of r.rows) expect(row, row.relname).toEqual({ relname: row.relname, has_policy: true });
	});

	it('copie initiale : app_sync voit toutes les organisations (le tri par appareil revient aux Sync Streams)', async () => {
		const r = await sync.query('select id from organizations where id = any($1::uuid[])', [[a.id, b.id]]);
		expect(r.rows).toHaveLength(2);
		const m = await sync.query('select count(*)::int as n from organization_members where organization_id = any($1::uuid[])', [
			[a.id, b.id]
		]);
		expect(m.rows[0].n).toBe(2);
	});

	it('les comptes, sessions, jetons, codes, abonnements et le journal ne lui sont pas lisibles', async () => {
		for (const table of [
			'users',
			'sessions',
			'refresh_tokens',
			'otp_codes',
			'subscriptions',
			'support_accesses',
			'audit_log',
			'organization_invitations'
		]) {
			await sync.query('BEGIN');
			try {
				expect((await sqlError(sync, `select 1 from ${table} limit 1`)).code, table).toBe('42501');
			} finally {
				await sync.query('ROLLBACK');
			}
		}
	});

	it('app_sync n’écrit nulle part, pas même dans les tables qu’il lit', async () => {
		await sync.query('BEGIN');
		try {
			expect((await sqlError(sync, `update organizations set trade_name = 'Piratée' where id = $1`, [a.id])).code).toBe('42501');
			expect((await sqlError(sync, `delete from organization_members where organization_id = $1`, [b.id])).code).toBe('42501');
			expect((await sqlError(sync, `insert into features (key) values ('x')`)).code).toBe('42501');
		} finally {
			await sync.query('ROLLBACK');
		}
	});

	it('les membres ont un nom affiché, recopié du compte (aucune réplication de users)', async () => {
		const r = await owner.query(
			`select m.display_name, u.name from organization_members m join users u on u.id = m.user_id where m.organization_id = $1`,
			[a.id]
		);
		expect(r.rows).toHaveLength(1);
		expect(r.rows[0].display_name).toBe(r.rows[0].name);
	});

	it('le nom affiché suit un changement de nom, dans chaque organisation de la personne', async () => {
		const renamed = await a.director.call('PATCH', '/me', { name: 'Awa Kaboré' });
		expect(renamed.status).toBe(200);
		const r = await owner.query(`select display_name from organization_members where organization_id = $1`, [a.id]);
		expect(r.rows).toEqual([{ display_name: 'Awa Kaboré' }]);
	});
});

describe('GET /sync/credentials : jeton dédié de PowerSync', () => {
	let t: TestApp;

	beforeAll(async () => {
		t = await startApp({ POWERSYNC_URL: 'https://sync.example.test', SYNC_TOKEN_TTL_SECONDS: '300' });
	});
	afterAll(() => t.close());

	it('refusé sans jeton d’accès', async () => {
		const r = await new Client(t.url).call('GET', '/sync/credentials');
		expect(r.status).toBe(401);
	});

	it('adresse du service et jeton EdDSA vérifiable par le JWKS public : audience ziga-sync, 5 minutes, la personne seule', async () => {
		const { client } = await signedUp(t);
		const me = await client.call<{ id: string }>('GET', '/me');
		const r = await client.call<{ endpoint: string; token: string; expiresAt: string }>('GET', '/sync/credentials');
		expect(r.status).toBe(200);
		expect(r.headers.get('cache-control')).toBe('no-store');
		expect(r.body.endpoint).toBe('https://sync.example.test');

		const header = decodeProtectedHeader(r.body.token);
		expect(header.alg).toBe('EdDSA');
		const jwks = (await (await fetch(`${t.url}/.well-known/jwks.json`)).json()) as JSONWebKeySet;
		expect(jwks.keys.map((k) => k.kid)).toContain(header.kid);

		// Vérification comme PowerSync : clé publique du JWKS, audience ziga-sync.
		const { payload } = await jwtVerify(r.body.token, createLocalJWKSet(jwks), { audience: 'ziga-sync', algorithms: ['EdDSA'] });
		expect(payload.sub).toBe(me.body.id);
		expect(payload.exp! - payload.iat!).toBe(300);
		expect(new Date(r.body.expiresAt).getTime()).toBe(payload.exp! * 1000);
		// Aucune organisation ni rôle dans le jeton : le stream lit les appartenances en direct.
		expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'sub']);
	});

	it('l’API refuse le jeton de synchronisation comme jeton d’accès (audience différente)', async () => {
		const { client } = await signedUp(t);
		const r = await client.call<{ token: string }>('GET', '/sync/credentials');
		const intruder = new Client(t.url);
		intruder.accessToken = r.body.token;
		expect((await intruder.call('GET', '/me')).status).toBe(401);
		expect((await intruder.call('GET', '/sync/credentials')).status).toBe(401);
	});

	it('compte désactivé depuis l’émission du jeton d’accès : plus de jeton de synchronisation', async () => {
		const { client } = await signedUp(t);
		const me = await client.call<{ id: string }>('GET', '/me');
		const owner = await connect(process.env.DATABASE_MIGRATION_URL!);
		try {
			await owner.query(`update users set status = 'disabled' where id = $1`, [me.body.id]);
		} finally {
			await owner.end();
		}
		expect((await client.call('GET', '/sync/credentials')).status).toBe(401);
	});
});
