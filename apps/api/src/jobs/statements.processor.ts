import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Module, type OnApplicationBootstrap } from '@nestjs/common';
import { toIsoDate } from '@ziga/shared/dates';
import { addMonthsToMonth, monthOfDate, STATEMENT_MONTH_PATTERN } from '@ziga/shared/statements';
import type { Job, Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { CollectionsModule } from '../modules/collections/collections.module.js';
import { StatementsService } from '../modules/collections/statements.service.js';
import {
	STATEMENT_PDF_JOB,
	STATEMENTS_MONTHLY_JOB,
	STATEMENTS_MONTHLY_PATTERN,
	STATEMENTS_MONTHLY_SCHEDULER,
	STATEMENTS_QUEUE,
	type StatementPdfJobData,
	type StatementsMonthlyJobData,
	type StatementsMonthlyJobResult
} from './queues.js';

/**
 * Relevés propriétaires (worker, lot 10) : PDF d'un relevé émis, et brouillons du mois écoulé le 1er de chaque mois.
 * Le service du module collections travaille dans le contexte de chaque organisation (RLS). Un brouillon n'est qu'un
 * calcul : rejouée, la tâche le recalcule sans rien émettre.
 */
@Processor(STATEMENTS_QUEUE)
export class StatementsProcessor extends WorkerHost implements OnApplicationBootstrap {
	constructor(
		private readonly statements: StatementsService,
		@InjectQueue(STATEMENTS_QUEUE) private readonly queue: Queue,
		private readonly logger: PinoLogger
	) {
		super();
		logger.setContext(StatementsProcessor.name);
	}

	async onApplicationBootstrap(): Promise<void> {
		await this.queue.upsertJobScheduler(
			STATEMENTS_MONTHLY_SCHEDULER,
			{ pattern: STATEMENTS_MONTHLY_PATTERN, tz: 'UTC' },
			{ name: STATEMENTS_MONTHLY_JOB, data: {} satisfies StatementsMonthlyJobData }
		);
	}

	async process(job: Job<StatementPdfJobData | StatementsMonthlyJobData>): Promise<unknown> {
		if (job.name === STATEMENT_PDF_JOB) {
			const data = job.data as StatementPdfJobData;
			const key = await this.statements.renderPdf(data.organizationId, data.statementId);
			this.logger.info({ statementId: data.statementId, generated: !!key }, 'PDF du relevé');
			return key;
		}
		if (job.name === STATEMENTS_MONTHLY_JOB) {
			const requested = (job.data as StatementsMonthlyJobData).month;
			const month = requested && STATEMENT_MONTH_PATTERN.test(requested) ? requested : addMonthsToMonth(monthOfDate(toIsoDate()), -1);
			const result = await this.statements.monthlyDrafts(month);
			this.logger.info({ month, ...result }, 'Brouillons des relevés du mois');
			return { month, ...result } satisfies StatementsMonthlyJobResult;
		}
		throw new Error(`Tâche inconnue : ${job.name}`);
	}
}

/** Worker seulement (lot 10) : le module collections y est chargé pour les relevés. */
@Module({ imports: [CollectionsModule], providers: [StatementsProcessor] })
export class StatementsWorkerModule {}
