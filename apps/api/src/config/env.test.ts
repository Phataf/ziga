import { describe, expect, it, vi } from 'vitest';
import { ConfigError, jobsDashboard, loadConfigOrExit, parseConfig } from './env.js';

const valid = {
	NODE_ENV: 'development',
	API_PORT: '3000',
	API_PUBLIC_URL: 'http://localhost:3000',
	CORS_ORIGINS: 'http://localhost:5173, http://localhost:4173/',
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
		expect(() => parseConfig({ ...valid, NODE_ENV: 'production' })).toThrow(/STORAGE_DRIVER/);
	});

	it('refuse la production sans clés de signature, sans secret des codes, et tant qu’aucun vrai prestataire SMS n’existe', () => {
		const s3 = {
			S3_ENDPOINT: 'https://s3.example.com',
			S3_REGION: 'eu',
			S3_BUCKET: 'ziga',
			S3_ACCESS_KEY_ID: 'a',
			S3_SECRET_ACCESS_KEY: 'b'
		};
		try {
			parseConfig({ ...valid, ...s3, NODE_ENV: 'production', STORAGE_DRIVER: 's3' });
			expect.unreachable();
		} catch (e) {
			const problems = (e as ConfigError).problems.join('\n');
			expect(problems).toContain('AUTH_JWT_KEYS');
			expect(problems).toContain('AUTH_OTP_SECRET');
			expect(problems).toContain('SMS_DRIVER : « console » est réservé au développement et aux tests');
		}
	});

	it('lit les origines autorisées et traite une variable vide comme absente', () => {
		const c = parseConfig({ ...valid, AUTH_OTP_SECRET: '', AUTH_JWT_KEYS: '' });
		expect(c.CORS_ORIGINS).toEqual(['http://localhost:5173', 'http://localhost:4173']);
		expect(c.AUTH_OTP_SECRET).toBeUndefined();
		expect(c.AUTH_REFRESH_COOKIE).toBe('__Host-ziga_rt');
		expect(c.RATE_LIMIT_PER_IP_PER_MINUTE).toBe(300);
	});

	it('coupe toujours le tableau de bord des files en production', () => {
		expect(parseConfig({ ...valid, JOBS_DASHBOARD: 'true' }).JOBS_DASHBOARD).toBe(true);
		expect(jobsDashboard('production', true)).toBe(false);
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
