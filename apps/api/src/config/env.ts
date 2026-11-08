/**
 * Configuration de l'API et du worker, validée par Zod au démarrage.
 * Une variable obligatoire manquante ou invalide empêche le démarrage (lot 01).
 * Aucune valeur secrète par défaut : tout vient de l'environnement (CLAUDE.md §6).
 */
import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

/** Une variable vide (« NOM= » dans .env) vaut une variable absente. */
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

/** Le tableau de bord des files n'est jamais ouvert en production. */
export function jobsDashboard(nodeEnv: string, asked: boolean): boolean {
	return nodeEnv === 'production' ? false : asked;
}

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/, error: 'URL PostgreSQL attendue (postgres://…)' });

export const envSchema = z
	.object({
		NODE_ENV: z.enum(['development', 'test', 'production']),
		LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
		LOG_PRETTY: bool.default(false),

		API_HOST: z.string().min(1).default('0.0.0.0'),
		API_PORT: z.coerce.number().int().min(0).max(65535),
		/** Adresse publique de l'API (D28) : émetteur des jetons. */
		API_PUBLIC_URL: z.url(),
		/** Origines du web autorisées (CORS et vérification d'origine des routes à cookie), séparées par des virgules. */
		CORS_ORIGINS: z
			.string()
			.min(1)
			.transform((v) => v.split(',').map((o) => o.trim().replace(/\/$/, '')))
			.pipe(z.array(z.url()).min(1)),

		/** Clés de signature des jetons d'accès (Ed25519) : « kid:pkcs8-base64 », la première signe, toutes vérifient. */
		AUTH_JWT_KEYS: optional(z.string()),
		/** Secret des empreintes des codes SMS (HMAC-SHA256), 32 caractères au moins. */
		AUTH_OTP_SECRET: optional(z.string().min(32)),
		AUTH_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
		AUTH_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
		AUTH_REFRESH_COOKIE: z
			.string()
			.regex(/^[A-Za-z0-9_-]+$/)
			.default('__Host-ziga_rt'),
		/** Réutilisation d'un jeton juste remplacé (connexion lente, onglets) : refus simple, sans révocation. */
		AUTH_REFRESH_REUSE_GRACE_SECONDS: z.coerce.number().int().min(0).max(60).default(10),
		OTP_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
		OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
		/** Débit : la limite principale porte sur le numéro ; le plafond par adresse IP reste large (adresses partagées). */
		RATE_LIMIT_LOGIN_PER_PHONE_PER_MINUTE: z.coerce.number().int().min(1).default(5),
		RATE_LIMIT_PER_IP_PER_MINUTE: z.coerce.number().int().min(1).default(300),
		OTP_SEND_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(60),
		OTP_SEND_PER_PHONE_PER_HOUR: z.coerce.number().int().min(1).default(5),
		/** Échecs de connexion : délai qui double à chaque échec (1 s, 2 s, 4 s…), plafonné. */
		AUTH_FAILURE_BASE_DELAY_MS: z.coerce.number().int().min(10).default(1_000),
		AUTH_FAILURE_MAX_DELAY_MS: z.coerce.number().int().min(10).default(60_000),
		/** Échecs tolérés par adresse IP (15 minutes) avant que son délai ne commence : beaucoup d'abonnés la partagent. */
		AUTH_IP_FAILURE_ALLOWANCE: z.coerce.number().int().min(0).default(20),

		/** SMS : console ou fichier en développement, mémoire pour les tests ; aucun en production avant le vrai prestataire. */
		SMS_DRIVER: z.enum(['console', 'file', 'memory']).default('console'),
		SMS_FILE: z.string().min(1).optional(),

		/** Rôle `app_api`, sans BYPASSRLS : connexion de toutes les routes, sauf celles du back-office. */
		DATABASE_URL: postgresUrl,
		/**
		 * Rôle `app_admin`, sans BYPASSRLS : connexion distincte, réservée aux routes /admin (module admin).
		 * Facultative en développement (back-office indisponible sans elle), obligatoire en production.
		 */
		DATABASE_ADMIN_URL: optional(postgresUrl),
		DATABASE_ADMIN_POOL_MAX: z.coerce.number().int().min(1).max(20).default(3),
		/** Abonnement échu (lot 04) : rappel N jours avant la fin, puis délai de grâce avant le blocage des créations. */
		SUBSCRIPTION_REMINDER_DAYS: z.coerce.number().int().min(0).max(60).default(7),
		SUBSCRIPTION_GRACE_DAYS: z.coerce.number().int().min(0).max(90).default(15),
		/** Durée de la copie locale des interrupteurs ; la propagation reste sous 30 secondes. */
		FEATURES_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(25).default(15),
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
		if (env.NODE_ENV === 'production') {
			if (!env.AUTH_JWT_KEYS)
				ctx.addIssue({
					code: 'custom',
					path: ['AUTH_JWT_KEYS'],
					message: 'obligatoire en production (pnpm --filter @ziga/api auth:keygen)'
				});
			if (!env.AUTH_OTP_SECRET) ctx.addIssue({ code: 'custom', path: ['AUTH_OTP_SECRET'], message: 'obligatoire en production' });
			if (!env.DATABASE_ADMIN_URL)
				ctx.addIssue({ code: 'custom', path: ['DATABASE_ADMIN_URL'], message: 'obligatoire en production (back-office)' });
			// Pas encore de prestataire SMS réel (question ouverte) : la production ne démarre pas avec un faux SMS.
			ctx.addIssue({ code: 'custom', path: ['SMS_DRIVER'], message: `« ${env.SMS_DRIVER} » est réservé au développement et aux tests` });
		}
		if (env.SMS_DRIVER === 'file' && !env.SMS_FILE) {
			ctx.addIssue({ code: 'custom', path: ['SMS_FILE'], message: 'obligatoire quand SMS_DRIVER=file' });
		}
	})
	.transform((env) => ({ ...env, JOBS_DASHBOARD: jobsDashboard(env.NODE_ENV, env.JOBS_DASHBOARD) }));

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
