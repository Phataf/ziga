import { describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfigOrExit, parseConfig } from './env.js';

const valid = {
	NODE_ENV: 'development',
	API_PORT: '3000',
	DATABASE_URL: 'postgres://app_api:x@localhost:5432/ziga',
	DATABASE_POOL_MAX: '10',
	DATABASE_STATEMENT_TIMEOUT_MS: '15000',
	REDIS_URL: 'redis://localhost:6379',
	STORAGE_DRIVER: 'local',
	STORAGE_LOCAL_DIR: '.data/storage'
};

describe('configuration', () => {
	it('accepte une configuration complète et applique les valeurs par défaut', () => {
		const c = parseConfig(valid);
		expect(c.API_PORT).toBe(3000);
		expect(c.DATABASE_POOL_MAX).toBe(10);
		expect(c.DATABASE_STATEMENT_TIMEOUT_MS).toBe(15000);
		expect(c.SHUTDOWN_TIMEOUT_MS).toBe(25000);
		expect(c.SENTRY_DSN).toBe('');
	});

	it('refuse de démarrer si une variable obligatoire manque, en la nommant', () => {
		const { DATABASE_URL: _, REDIS_URL: __, ...env } = valid;
		expect(() => parseConfig(env)).toThrow(ConfigError);
		try {
			parseConfig(env);
		} catch (e) {
			expect((e as ConfigError).problems).toEqual(
				expect.arrayContaining(['DATABASE_URL : variable obligatoire manquante', 'REDIS_URL : variable obligatoire manquante'])
			);
		}
	});

	it('refuse une taille de pool ou un délai de requête invalides', () => {
		expect(() => parseConfig({ ...valid, DATABASE_POOL_MAX: '0' })).toThrow(ConfigError);
		expect(() => parseConfig({ ...valid, DATABASE_STATEMENT_TIMEOUT_MS: 'beaucoup' })).toThrow(ConfigError);
	});

	it('exige les paramètres S3 avec le stockage S3, et refuse le stockage local en production', () => {
		expect(() => parseConfig({ ...valid, STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET/);
		const s3 = {
			S3_ENDPOINT: 'https://s3.example.com',
			S3_REGION: 'eu',
			S3_BUCKET: 'ziga',
			S3_ACCESS_KEY_ID: 'a',
			S3_SECRET_ACCESS_KEY: 'b'
		};
		expect(() => parseConfig({ ...valid, NODE_ENV: 'production' })).toThrow(/STORAGE_DRIVER/);
		expect(parseConfig({ ...valid, ...s3, NODE_ENV: 'production', STORAGE_DRIVER: 's3' }).STORAGE_DRIVER).toBe('s3');
	});

	it('coupe toujours le tableau de bord des files en production', () => {
		const s3 = {
			S3_ENDPOINT: 'https://s3.example.com',
			S3_REGION: 'eu',
			S3_BUCKET: 'ziga',
			S3_ACCESS_KEY_ID: 'a',
			S3_SECRET_ACCESS_KEY: 'b'
		};
		expect(parseConfig({ ...valid, JOBS_DASHBOARD: 'true' }).JOBS_DASHBOARD).toBe(true);
		expect(parseConfig({ ...valid, ...s3, STORAGE_DRIVER: 's3', NODE_ENV: 'production', JOBS_DASHBOARD: 'true' }).JOBS_DASHBOARD).toBe(
			false
		);
	});

	it('au démarrage, écrit les problèmes et quitte avec le code 1', () => {
		const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const exit = vi.fn((code: number) => {
			throw new Error(`exit ${code}`);
		}) as unknown as (code: number) => never;
		expect(() => loadConfigOrExit({}, exit)).toThrow('exit 1');
		expect(stderr.mock.calls.join('')).toContain('NODE_ENV : variable obligatoire manquante');
		stderr.mockRestore();
	});
});
