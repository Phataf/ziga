import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { type OnApplicationBootstrap } from '@nestjs/common';
import { isIsoDate, toIsoDate } from '@ziga/shared/dates';
import type { Job, Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { DatabaseService } from '../db/database.module.js';
import { AuditService } from '../modules/audit/audit.service.js';
import { runLeasesDaily } from '../modules/leases/leases-daily.js';
import { RentDueEvents } from '../modules/leases/rent-due-events.js';
import { LEASES_DAILY_JOB, LEASES_DAILY_PATTERN, LEASES_DAILY_SCHEDULER, LEASES_QUEUE, type LeasesDailyJobData } from './queues.js';

/**
 * Tâche quotidienne des baux (lot 08, worker seulement). Le planificateur est posé au démarrage du worker (idempotent).
 * La tâche passe par le module leases : chaque organisation concernée est ouverte dans son propre contexte, sous la RLS.
 */
@Processor(LEASES_QUEUE)
export class LeasesDailyProcessor extends WorkerHost implements OnApplicationBootstrap {
	constructor(
		private readonly database: DatabaseService,
		private readonly audit: AuditService,
		private readonly events: RentDueEvents,
		@InjectQueue(LEASES_QUEUE) private readonly queue: Queue,
		private readonly logger: PinoLogger
	) {
		super();
		logger.setContext(LeasesDailyProcessor.name);
	}

	async onApplicationBootstrap(): Promise<void> {
		await this.queue.upsertJobScheduler(
			LEASES_DAILY_SCHEDULER,
			{ pattern: LEASES_DAILY_PATTERN, tz: 'UTC' },
			{ name: LEASES_DAILY_JOB, data: {} satisfies LeasesDailyJobData }
		);
	}

	async process(job: Job<LeasesDailyJobData>) {
		const today = job.data.today && isIsoDate(job.data.today) ? job.data.today : toIsoDate();
		const result = await runLeasesDaily(this.database, this.audit, today, this.events);
		this.logger.info({ today, ...result }, 'Baux et échéances du jour');
		return { today, ...result };
	}
}
