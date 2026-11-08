/**
 * API des tests de bout en bout (Playwright) : base `ziga_e2e` recréée et migrée, base Redis n° 2 vidée,
 * un super administrateur de test, les données de démonstration, SMS écrits dans un fichier (lu par les tests),
 * puis démarrage de l'API et du worker.
 * Lancé par apps/web/playwright.config.ts après `nest build`. Jamais en production.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { Redis } from 'ioredis';
import pg from 'pg';

const api = resolve(import.meta.dirname, '..');
const root = resolve(api, '../..');
const file = join(root, '.env');
const base = { ...(existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}), ...process.env };
for (const key of ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'DATABASE_MIGRATION_URL', 'REDIS_URL', 'E2E_SMS_FILE']) {
	if (!base[key]) throw new Error(`Tests de bout en bout : ${key} manquante.`);
}

const name = 'ziga_e2e';
const withPath = (url, path) => {
	const u = new URL(url);
	u.pathname = path;
	return u.toString();
};

const env = {
	...base,
	NODE_ENV: 'test',
	LOG_LEVEL: base.E2E_LOG_LEVEL || 'warn',
	LOG_PRETTY: 'false',
	API_HOST: '127.0.0.1',
	API_PORT: base.E2E_API_PORT || '3100',
	DATABASE_URL: withPath(base.DATABASE_URL, `/${name}`),
	DATABASE_ADMIN_URL: withPath(base.DATABASE_ADMIN_URL, `/${name}`),
	DATABASE_MIGRATION_URL: withPath(base.DATABASE_MIGRATION_URL, `/${name}`),
	REDIS_URL: withPath(base.REDIS_URL, '/2'),
	STORAGE_DRIVER: 'local',
	STORAGE_LOCAL_DIR: join(dirname(base.E2E_SMS_FILE), 'ziga-e2e-storage'),
	JOBS_DASHBOARD: 'false',
	API_PUBLIC_URL: `http://localhost:${base.E2E_API_PORT || '3100'}`,
	CORS_ORIGINS: base.E2E_WEB_ORIGIN || 'http://localhost:4173',
	AUTH_JWT_KEYS: '',
	AUTH_OTP_SECRET: 'secret-des-codes-pour-les-tests-de-bout-en-bout',
	SMS_DRIVER: 'file',
	SMS_FILE: base.E2E_SMS_FILE,
	// Chaque test se connecte avec le même compte : limites de débit relevées pour ce compte de test seulement.
	RATE_LIMIT_LOGIN_PER_PHONE_PER_MINUTE: '1000',
	RATE_LIMIT_PER_IP_PER_MINUTE: '5000',
	OTP_SEND_INTERVAL_SECONDS: '0',
	OTP_SEND_PER_PHONE_PER_HOUR: '1000',
	SENTRY_DSN: ''
};

const server = new pg.Client({ connectionString: withPath(env.DATABASE_MIGRATION_URL, '/postgres') });
await server.connect();
await server.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
await server.query(`CREATE DATABASE ${name}`);
await server.end();

const redis = new Redis(env.REDIS_URL);
await redis.flushdb();
redis.disconnect();
rmSync(env.SMS_FILE, { force: true });

const { runMigrations } = await import(join(api, 'dist/db/migrate.js'));
await runMigrations({ migrationUrl: env.DATABASE_MIGRATION_URL, roleUrls: [env.DATABASE_URL, env.DATABASE_ADMIN_URL] });

// Super administrateur de test (base jetable ; mot de passe de test, pas un secret).
const { createDatabase, createPool } = await import(join(api, 'dist/db/database.js'));
const { createSuperAdmin } = await import(join(api, 'dist/modules/identity/super-admin.js'));
const pool = createPool({ url: env.DATABASE_URL, max: 1, connectionTimeoutMs: 5_000, applicationName: 'ziga-e2e' });
await createSuperAdmin(createDatabase(pool), {
	phone: base.E2E_ADMIN_PHONE || '+22670000001',
	name: 'Admin Ziga',
	password: base.E2E_ADMIN_PASSWORD || 'admin-de-test-e2e'
});
// Personne sans organisation, déjà vérifiée : compte des tests de la coque (le parcours d'inscription crée les siens).
const { users } = await import(join(api, 'dist/db/schema/identity.js'));
const { hashPassword } = await import(join(api, 'dist/modules/identity/passwords.js'));
const { newId } = await import('@ziga/shared/ids');
await createDatabase(pool)
	.insert(users)
	.values({
		id: newId(),
		phone: base.E2E_PERSON_PHONE || '+22670000002',
		name: 'Awa Ouédraogo',
		passwordHash: await hashPassword(base.E2E_PERSON_PASSWORD || 'personne-de-test-e2e'),
		status: 'active',
		phoneVerifiedAt: new Date()
	});
// Démonstration du lot 03 : agences A et B (un membre par rôle) et un bailleur particulier.
const { seedDemo } = await import(join(api, 'dist/db/seed.js'));
await seedDemo(createDatabase(pool), base.E2E_DEMO_PASSWORD || 'demo-de-test-e2e');
await pool.end();

// API HTTP et worker (logos traités par sharp) : deux processus, comme en production.
const children = ['dist/main.js', 'dist/worker.js'].map((file) => spawn(process.execPath, [join(api, file)], { env, stdio: 'inherit' }));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => children.forEach((c) => c.kill(signal)));
for (const child of children) {
	child.on('exit', (code) => {
		children.forEach((c) => c.kill('SIGTERM'));
		process.exit(code ?? 0);
	});
}
