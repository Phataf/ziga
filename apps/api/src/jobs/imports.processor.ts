import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Module, type OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { ImportExecutor } from '../modules/imports/import-executor.js';
import { ImportsModule } from '../modules/imports/imports.module.js';
import {
	IMPORT_ANALYZE_JOB,
	IMPORT_CANCEL_JOB,
	IMPORT_EXECUTE_JOB,
	IMPORT_PURGE_JOB,
	IMPORT_PURGE_PATTERN,
	IMPORT_PURGE_SCHEDULER,
	IMPORTS_QUEUE,
	type ImportJobData,
	type ImportPurgeJobData
} from './queues.js';

/**
 * Import Excel (worker, lot 11) : lecture et analyse, exécution onglet par onglet, annulation, et effacement quotidien
 * des fichiers d'origine échus. Une panne est rejouée par BullMQ (les onglets déjà validés sont sautés) ; après la
 * dernière tentative, l'import passe « échoué », avec le message.
 */
@Processor(IMPORTS_QUEUE)
export class ImportsProcessor extends WorkerHost implements OnApplicationBootstrap {
	constructor(
		private readonly executor: ImportExecutor,
		@InjectQueue(IMPORTS_QUEUE) private readonly queue: Queue,
		private readonly logger: PinoLogger
	) {
		super();
		logger.setContext(ImportsProcessor.name);
	}

	async onApplicationBootstrap(): Promise<void> {
		await this.queue.upsertJobScheduler(
			IMPORT_PURGE_SCHEDULER,
			{ pattern: IMPORT_PURGE_PATTERN, tz: 'UTC' },
			{ name: IMPORT_PURGE_JOB, data: {} satisfies ImportPurgeJobData }
		);
	}

	async process(job: Job<ImportJobData | ImportPurgeJobData>): Promise<unknown> {
		if (job.name === IMPORT_PURGE_JOB) {
			const now = (job.data as ImportPurgeJobData).now;
			const purged = await this.executor.purgeFiles(now ? new Date(now) : new Date());
			this.logger.info({ purged }, 'Fichiers d’import échus effacés');
			return { purged };
		}
		const data = job.data as ImportJobData;
		if (job.name === IMPORT_ANALYZE_JOB) return this.executor.analyze(data.organizationId, data.importJobId, data.userId);
		if (job.name === IMPORT_CANCEL_JOB) return this.executor.cancel(data.organizationId, data.importJobId, data.userId, data.reason ?? '');
		if (job.name !== IMPORT_EXECUTE_JOB) throw new Error(`Tâche inconnue : ${job.name}`);
		try {
			return await this.executor.execute(data.organizationId, data.importJobId, data.userId);
		} catch (error) {
			const last = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
			this.logger.warn(
				{ importJobId: data.importJobId, attempt: job.attemptsMade + 1, error: (error as Error).message },
				'Exécution de l’import interrompue'
			);
			if (last) {
				await this.executor
					.failExecution(
						data.organizationId,
						data.importJobId,
						data.userId,
						'L’import s’est interrompu ; les onglets déjà importés sont gardés. Relancez-le.'
					)
					.catch(() => undefined);
			}
			throw error;
		}
	}
}

/** Worker seulement (lot 11) : le module imports et, par lui, les services des modules qu'il alimente. */
@Module({ imports: [ImportsModule], providers: [ImportsProcessor] })
export class ImportsWorkerModule {}
