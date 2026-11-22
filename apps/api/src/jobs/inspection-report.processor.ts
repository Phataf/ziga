import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { DatabaseService } from '../db/database.module.js';
import { ExitService } from '../modules/leases/exit.service.js';
import { LeasesModule } from '../modules/leases/leases.module.js';
import { requireMembership, runInOrganization } from '../modules/organizations/organization-context.js';
import { INSPECTION_REPORT_JOB, INSPECTIONS_QUEUE, type InspectionReportJobData } from './queues.js';

/**
 * PDF de l'état des lieux (worker, lot 10 bis, étape 4) : dans le contexte de l'organisation et de la personne qui l'a
 * déclenché (membre actif revérifié), par le service du module leases ; audit d'origine `job`. Un échec passager est
 * retenté par BullMQ ; chaque génération écrit une nouvelle version.
 */
@Processor(INSPECTIONS_QUEUE)
export class InspectionReportProcessor extends WorkerHost {
	constructor(
		private readonly database: DatabaseService,
		private readonly exit: ExitService,
		private readonly logger: PinoLogger
	) {
		super();
		logger.setContext(InspectionReportProcessor.name);
	}

	async process(job: Job<InspectionReportJobData>): Promise<unknown> {
		if (job.name !== INSPECTION_REPORT_JOB) throw new Error(`Tâche inconnue : ${job.name}`);
		const { organizationId, userId, inspectionId } = job.data;
		const scope = await requireMembership(this.database, userId, organizationId);
		const result = await runInOrganization(this.database, scope, userId, () => this.exit.renderInspectionReport(inspectionId), 'job');
		this.logger.info({ inspectionId, ...result }, 'PDF de l’état des lieux');
		return result;
	}
}

/** Worker seulement : le PDF passe par le service du module leases (et, par lui, par le module documents). */
@Module({ imports: [LeasesModule], providers: [InspectionReportProcessor] })
export class InspectionReportWorkerModule {}
