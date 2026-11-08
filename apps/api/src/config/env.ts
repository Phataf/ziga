/**
 * Configuration de l'API et du worker, validée par Zod au démarrage.
 * Une variable obligatoire manquante ou invalide empêche le démarrage (lot 01).
 * Aucune valeur secrète par défaut : tout vient de l'environnement (CLAUDE.md §6).
 */
import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/, error: 'URL PostgreSQL attendue (postgres://…)' });

export const envSchema = z
	.object({
		NODE_ENV: z.enum(['development', 'test', 'production']),
		LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
		LOG_PRETTY: bool.default(false),

		API_HOST: z.string().min(1).default('0.0.0.0'),
		API_PORT: z.coerce.number().int().min(0).max(65535),

		/** Rôle `app_api`, sans BYPASSRLS : seule connexion utilisée par l'API et le worker. */
		DATABASE_URL: postgresUrl,
		DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200),
		DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000),
		DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),

		REDIS_URL: z.url({ protocol: /^rediss?$/, error: 'URL Redis attendue (redis://…)' }),

		STORAGE_DRIVER: z.enum(['s3', 'local']),
		STORAGE_LOCAL_DIR: z.string().min(1).optional(),
		S3_ENDPOINT: z.url().optional(),
		S3_REGION: z.string().min(1).optional(),
		S3_BUCKET: z.string().min(3).optional(),
		S3_ACCESS_KEY_ID: z.string().min(1).optional(),
		S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
		S3_FORCE_PATH_STYLE: bool.default(true),

		SENTRY_DSN: z.union([z.url(), z.literal('')]).default(''),
		SENTRY_ENVIRONMENT: z.string().default('development'),

		JOBS_DASHBOARD: bool.default(false),
		WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),

		/** Délai laissé aux requêtes et aux tâches en cours avant l'arrêt forcé. */
		SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(25_000),
		/** Délai de vérification de chaque dépendance dans /health/ready. */
		HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2_000)
	})
	.superRefine((env, ctx) => {
		if (env.STORAGE_DRIVER === 's3') {
			for (const key of ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
				if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'obligatoire quand STORAGE_DRIVER=s3' });
			}
		}
		if (env.STORAGE_DRIVER === 'local' && !env.STORAGE_LOCAL_DIR) {
			ctx.addIssue({ code: 'custom', path: ['STORAGE_LOCAL_DIR'], message: 'obligatoire quand STORAGE_DRIVER=local' });
		}
		if (env.NODE_ENV === 'production' && env.STORAGE_DRIVER !== 's3') {
			ctx.addIssue({ code: 'custom', path: ['STORAGE_DRIVER'], message: 'le stockage local est réservé au développement et aux tests' });
		}
	})
	.transform((env) => ({
		...env,
		// Le tableau de bord des files n'est jamais ouvert en production.
		JOBS_DASHBOARD: env.NODE_ENV === 'production' ? false : env.JOBS_DASHBOARD
	}));

export type AppConfig = z.infer<typeof envSchema>;

export class ConfigError extends Error {
	constructor(public readonly problems: string[]) {
		super(`Configuration invalide, démarrage refusé :\n${problems.map((p) => `  - ${p}`).join('\n')}`);
		this.name = 'ConfigError';
	}
}

/** Valide l'environnement ; lève une ConfigError qui liste chaque variable manquante ou invalide. */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
	const result = envSchema.safeParse(env);
	if (result.success) return result.data;
	const problems = result.error.issues.map((i) => {
		const key = i.path.join('.') || '(configuration)';
		const missing = i.code !== 'custom' && env[key] === undefined;
		return missing ? `${key} : variable obligatoire manquante` : `${key} : ${i.message}`;
	});
	throw new ConfigError(problems);
}

/** Au démarrage : écrit les problèmes sur la sortie d'erreur et quitte avec le code 1. */
export function loadConfigOrExit(env: Record<string, string | undefined>, exit: (code: number) => never = process.exit): AppConfig {
	try {
		return parseConfig(env);
	} catch (error) {
		if (error instanceof ConfigError) {
			process.stderr.write(`${error.message}\n`);
			return exit(1);
		}
		throw error;
	}
}
