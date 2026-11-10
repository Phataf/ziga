import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { DatabaseService } from '../db/database.module.js';
import { AuditService } from '../modules/audit/audit.service.js';
import { processMediaUpload, type ProcessResult } from '../modules/properties/media-processing.js';
import { STORAGE, type StorageAdapter } from '../storage/storage.js';
import { MEDIA_QUEUE, type MediaJobData } from './queues.js';

/**
 * Traitement d'une photo envoyée (worker seulement), dans le contexte de son organisation, par la fonction du module
 * properties. L'original est effacé après la validation de la transaction, que la photo soit acceptée ou refusée.
 */
@Processor(MEDIA_QUEUE)
export class MediaProcessor extends WorkerHost {
	constructor(
		private readonly database: DatabaseService,
		private readonly audit: AuditService,
		@Inject(STORAGE) private readonly storage: StorageAdapter,
		private readonly logger: PinoLogger
	) {
		super();
		logger.setContext(MediaProcessor.name);
	}

	async process(job: Job<MediaJobData>): Promise<ProcessResult> {
		const { organizationId, mediaId } = job.data;
		const result = await this.database.withOrganization(organizationId, (tx) =>
			processMediaUpload(tx, { storage: this.storage, audit: this.audit }, organizationId, mediaId)
		);
		if (result.deleteKey) await this.storage.delete(result.deleteKey);
		if (result.status === 'rejected') this.logger.warn({ mediaId, error: result.error }, 'Photo refusée');
		return { status: result.status, error: result.error };
	}
}
