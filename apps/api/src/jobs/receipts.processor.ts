import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { PaymentsModule } from '../modules/payments/payments.module.js';
import { PaymentsService } from '../modules/payments/payments.service.js';
import { RECEIPT_PDF_JOB, RECEIPTS_QUEUE, type ReceiptPdfJobData } from './queues.js';

/**
 * Reçus (worker, lot 09) : PDF A6 et ticket d'un reçu émis, ou régénéré « ANNULÉ ». Le service du module payments
 * travaille dans le contexte de l'organisation du reçu (RLS). Un échec passager (stockage) est retenté par BullMQ ;
 * le reçu reste consultable à l'écran et sur la page de vérification en attendant.
 */
@Processor(RECEIPTS_QUEUE)
export class ReceiptsProcessor extends WorkerHost {
	constructor(
		private readonly payments: PaymentsService,
		private readonly logger: PinoLogger
	) {
		super();
		logger.setContext(ReceiptsProcessor.name);
	}

	async process(job: Job<ReceiptPdfJobData>): Promise<unknown> {
		if (job.name !== RECEIPT_PDF_JOB) throw new Error(`Tâche inconnue : ${job.name}`);
		const keys = await this.payments.renderPdf(job.data.organizationId, job.data.receiptId);
		this.logger.info({ receiptId: job.data.receiptId, generated: !!keys }, 'PDF du reçu');
		return keys;
	}
}

/**
 * Worker seulement (lot 09) : le module payments y est chargé pour les PDF des reçus, et pour imputer le crédit du
 * bail sur les échéances émises par la tâche de nuit (événement du module leases).
 */
@Module({ imports: [PaymentsModule], providers: [ReceiptsProcessor] })
export class PaymentsWorkerModule {}
