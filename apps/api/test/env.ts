/**
 * Environnement des tests d'intégration : celui du fichier .env (ou de la CI), avec une base dédiée
 * (TEST_DATABASE_NAME, `ziga_test` par défaut) recréée à chaque exécution, et un stockage local temporaire.
 */
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

const root = resolve(import.meta.dirname, '../../..');

function withDatabase(url: string, name: string): string {
	const u = new URL(url);
	u.pathname = `/${name}`;
	return u.toString();
}

function withRedisDb(url: string, db: number): string {
	const u = new URL(url);
	u.pathname = `/${db}`;
	return u.toString();
}

export function integrationEnv(): Record<string, string> {
	// Les variables déjà définies (CI) l'emportent sur le fichier .env (développement).
	const file = join(root, '.env');
	const fromFile = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
	const base = { ...fromFile, ...process.env } as Record<string, string>;
	const name = base.TEST_DATABASE_NAME || 'ziga_test';
	for (const key of ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'DATABASE_SYNC_URL', 'DATABASE_MIGRATION_URL', 'REDIS_URL']) {
		if (!base[key]) throw new Error(`Tests d'intégration : ${key} manquante (copiez .env.example en .env).`);
	}
	return {
		...base,
		NODE_ENV: 'test',
		LOG_LEVEL: 'silent',
		LOG_PRETTY: 'false',
		API_PORT: '0',
		DATABASE_URL: withDatabase(base.DATABASE_URL!, name),
		DATABASE_ADMIN_URL: withDatabase(base.DATABASE_ADMIN_URL!, name),
		DATABASE_SYNC_URL: withDatabase(base.DATABASE_SYNC_URL!, name),
		DATABASE_MIGRATION_URL: withDatabase(base.DATABASE_MIGRATION_URL!, name),
		DATABASE_POOL_MAX: base.DATABASE_POOL_MAX || '5',
		DATABASE_STATEMENT_TIMEOUT_MS: base.DATABASE_STATEMENT_TIMEOUT_MS || '15000',
		STORAGE_DRIVER: 'local',
		STORAGE_LOCAL_DIR: join(tmpdir(), 'ziga-test-storage'),
		JOBS_DASHBOARD: 'false',
		// Base Redis à part (n° 1), vidée à chaque exécution : les compteurs de débit repartent de zéro.
		REDIS_URL: withRedisDb(base.REDIS_URL!, 1),
		API_PUBLIC_URL: base.API_PUBLIC_URL || 'http://localhost:3000',
		CORS_ORIGINS: 'http://localhost:5173',
		AUTH_JWT_KEYS: '',
		AUTH_OTP_SECRET: 'secret-des-codes-pour-les-tests-uniquement',
		SMS_DRIVER: 'memory',
		OTP_SEND_INTERVAL_SECONDS: '0',
		OTP_SEND_PER_PHONE_PER_HOUR: '50',
		SENTRY_DSN: '',
		TEST_DATABASE_NAME: name
	};
}
