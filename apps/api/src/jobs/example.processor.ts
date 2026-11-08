import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';
import { EXAMPLE_QUEUE, type ExampleJobData, type ExampleJobResult } from './queues.js';

/** Processeur d'exemple : il ne tourne que dans le worker, jamais dans le processus HTTP. */
@Processor(EXAMPLE_QUEUE)
export class ExampleProcessor extends WorkerHost implements OnApplicationBootstrap {
	constructor(
		private readonly logger: PinoLogger,
		@Inject(APP_CONFIG) private readonly config: AppConfig
	) {
		super();
		logger.setContext(ExampleProcessor.name);
	}

	/** Nombre de tâches traitées en parallèle par ce processus (WORKER_CONCURRENCY). */
	onApplicationBootstrap(): void {
		this.worker.concurrency = this.config.WORKER_CONCURRENCY;
	}

	async process(job: Job<ExampleJobData>): Promise<ExampleJobResult> {
		this.logger.info({ jobId: job.id }, 'Tâche d’exemple traitée');
		return { length: job.data.message.length, processedBy: process.pid };
	}
}
