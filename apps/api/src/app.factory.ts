import 'reflect-metadata';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { getQueueToken } from '@nestjs/bullmq';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Queue } from 'bullmq';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import type { AppConfig } from './config/env.js';
import { EXAMPLE_QUEUE } from './jobs/queues.js';

export const JOBS_DASHBOARD_PATH = '/admin/queues';

/** Construit l'application HTTP (utilisé par main.ts et par les tests d'intégration). */
export async function createApp(config: AppConfig): Promise<NestExpressApplication> {
	const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), { bufferLogs: true });
	app.useLogger(app.get(Logger));
	app.disable('x-powered-by');
	app.set('trust proxy', 1);

	// Tableau de bord des files : développement seulement (forcé à faux en production par la configuration).
	if (config.JOBS_DASHBOARD) {
		const serverAdapter = new ExpressAdapter();
		serverAdapter.setBasePath(JOBS_DASHBOARD_PATH);
		createBullBoard({ queues: [new BullMQAdapter(app.get<Queue>(getQueueToken(EXAMPLE_QUEUE)))], serverAdapter });
		app.use(JOBS_DASHBOARD_PATH, serverAdapter.getRouter());
	}
	return app;
}
