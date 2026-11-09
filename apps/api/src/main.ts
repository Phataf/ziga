/**
 * Point d'entrée HTTP. La configuration est validée avant tout : une variable manquante arrête le démarrage.
 * Les modules NestJS sont chargés après Sentry, pour que son instrumentation s'applique.
 */
import { loadConfigOrExit } from './config/env.js';
import { initSentry } from './common/sentry.js';

const config = loadConfigOrExit(process.env);
initSentry(config, 'api');

// Base en retard (« pnpm db:migrate » oublié) : arrêt avec un message clair plutôt qu'une erreur SQL à la première requête.
const { assertMigrationsOrExit } = await import('./db/migration-status.js');
await assertMigrationsOrExit(config.DATABASE_URL);

const { createApp } = await import('./app.factory.js');
const { registerGracefulShutdown } = await import('./common/shutdown.js');
const { HealthService } = await import('./health/health.service.js');
const { Logger } = await import('nestjs-pino');

const app = await createApp(config);
const logger = app.get(Logger);
registerGracefulShutdown(app, {
	timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
	logger: { info: (m) => logger.log(m), error: (o, m) => logger.error(o, m) },
	// /health/ready répond 503 dès le signal, le temps que le répartiteur retire l'instance.
	beforeClose: () => {
		app.get(HealthService).shuttingDown = true;
	}
});
await app.listen(config.API_PORT, config.API_HOST);
logger.log(`API prête sur ${config.API_HOST}:${config.API_PORT}`);
