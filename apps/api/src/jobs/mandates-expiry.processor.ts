import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { type OnApplicationBootstrap } from '@nestjs/common';
import { isIsoDate, toIsoDate } from '@ziga/shared/dates';
import type { Job, Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { DatabaseService } from '../db/database.module.js';
import { AuditService } from '../modules/audit/audit.service.js';
import { expireAllDueMandates } from '../modules/owners/mandate-expiry.js';
import {
	MANDATES_EXPIRY_JOB,
	MANDATES_EXPIRY_PATTERN,
	MANDATES_EXPIRY_SCHEDULER,
	MANDATES_QUEUE,
	type MandatesExpiryJobData,
	type MandatesExpiryJobResult
} from './queues.js';

/**
 * Expiration quotidienne des mandats (lot 06, worker seulement). Le planificateur est posé au démarrage du worker
 * (idempotent : un seul planificateur, même avec plusieurs workers). La tâche passe par le service public du module
 * owners : chaque organisation concernée est ouverte dans son propre contexte, sous la RLS.
 */
@Processor(MANDATES_QUEUE)
export class MandatesExpiryProcessor extends WorkerHost implements OnApplicationBootstrap {
	constructor(
		private readonly database: DatabaseService,
		private readonly audit: AuditService,
		@InjectQueue(MANDATES_QUEUE) private readonly queue: Queue,
		private readonly logger: PinoLogger
	) {
		super();
		logger.setContext(MandatesExpiryProcessor.name);
	}

	async onApplicationBootstrap(): Promise<void> {
		await this.queue.upsertJobScheduler(
			MANDATES_EXPIRY_SCHEDULER,
			{ pattern: MANDATES_EXPIRY_PATTERN, tz: 'UTC' },
			{ name: MANDATES_EXPIRY_JOB, data: {} satisfies MandatesExpiryJobData }
		);
	}

	async process(job: Job<MandatesExpiryJobData>): Promise<MandatesExpiryJobResult> {
		const today = job.data.today && isIsoDate(job.data.today) ? job.data.today : toIsoDate();
		const result = await expireAllDueMandates(this.database, this.audit, today);
		this.logger.info({ today, ...result }, 'Mandats expirés');
		return { today, ...result };
	}
}
