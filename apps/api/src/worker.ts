/**
 * Point d'entrée du worker BullMQ, lancé comme un processus distinct de l'API :
 * les tâches lourdes ne ralentissent jamais les requêtes, et chacun se multiplie séparément.
 */
import { loadConfigOrExit } from './config/env.js';
import { initSentry } from './common/sentry.js';

const config = loadConfigOrExit(process.env);
initSentry(config, 'worker');

await import('reflect-metadata');
const { NestFactory } = await import('@nestjs/core');
const { Logger } = await import('nestjs-pino');
const { WorkerModule } = await import('./worker.module.js');
const { registerGracefulShutdown } = await import('./common/shutdown.js');

const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), { bufferLogs: true });
const logger = app.get(Logger);
app.useLogger(logger);
// À l'arrêt, @nestjs/bullmq ferme chaque worker : BullMQ attend la fin des tâches en cours avant de rendre la main.
registerGracefulShutdown(app, {
	timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
	logger: { info: (m) => logger.log(m), error: (o, m) => logger.error(o, m) }
});
await app.init();
logger.log(`Worker prêt (concurrence ${config.WORKER_CONCURRENCY})`);
