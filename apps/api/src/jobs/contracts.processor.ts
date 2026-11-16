import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { DatabaseService } from '../db/database.module.js';
import { ContractsService } from '../modules/leases/contracts/contracts.service.js';
import { requireMembership, runInOrganization } from '../modules/organizations/organization-context.js';
import {
	CONTRACT_GENERATE_JOB,
	CONTRACTS_QUEUE,
	TEMPLATE_PREVIEW_JOB,
	type ContractGenerateJobData,
	type TemplatePreviewJobData
} from './queues.js';

/**
 * Contrats (worker, lot 08 bis) : génération d'une version et aperçu d'un modèle, dans le contexte de l'organisation
 * et de la personne qui les a demandés (membre actif revérifié : un membre retiré entre-temps ne génère plus rien),
 * avec le même service que les routes ; audit d'origine `job`. Un échec passager (service de conversion injoignable)
 * est retenté par BullMQ ; après la dernière tentative, le contrat porte l'échec, lisible à l'écran.
 */
@Processor(CONTRACTS_QUEUE)
export class ContractsProcessor extends WorkerHost {
	constructor(
		private readonly database: DatabaseService,
		private readonly contracts: ContractsService,
		private readonly logger: PinoLogger
	) {
		super();
		logger.setContext(ContractsProcessor.name);
	}

	private async inContext<T>(organizationId: string, userId: string, fn: () => Promise<T>): Promise<T> {
		const scope = await requireMembership(this.database, userId, organizationId);
		return runInOrganization(this.database, scope, userId, fn, 'job');
	}

	async process(job: Job<ContractGenerateJobData | TemplatePreviewJobData>): Promise<unknown> {
		if (job.name === TEMPLATE_PREVIEW_JOB) {
			const data = job.data as TemplatePreviewJobData;
			return {
				documentId: await this.inContext(data.organizationId, data.userId, () => this.contracts.renderTemplatePreview(data.templateId))
			};
		}
		if (job.name !== CONTRACT_GENERATE_JOB) throw new Error(`Tâche inconnue : ${job.name}`);
		const data = job.data as ContractGenerateJobData;
		try {
			return await this.inContext(data.organizationId, data.userId, () => this.contracts.generateVersion(data.contractId, data.number));
		} catch (error) {
			const last = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
			this.logger.warn(
				{ contractId: data.contractId, attempt: job.attemptsMade + 1, error: (error as Error).message },
				'Génération du contrat en échec'
			);
			if (last) {
				await this.inContext(data.organizationId, data.userId, () =>
					this.contracts.generationFailed(data.contractId, (error as Error).message)
				).catch(() => undefined);
			}
			throw error;
		}
	}
}
