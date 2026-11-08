/**
 * Logo de l'organisation (lot 03) : chaque envoi crée une version, jamais écrasée (D29) ; le traitement par sharp
 * se fait dans une tâche de fond, lancée après la validation de la transaction.
 */
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@ziga/shared/ids';
import type { OrganizationView } from '@ziga/shared/organizations';
import type { Queue } from 'bullmq';
import { RequestContext } from '../../common/request-context.js';
import { organizationLogos } from '../../db/schema/organizations.js';
import { LOGO_QUEUE, type LogoJobData } from '../../jobs/queues.js';
import { STORAGE, type StorageAdapter } from '../../storage/storage.js';
import { AuditService } from '../audit/audit.service.js';
import { assertLogo, logoKey } from './logo-files.js';
import { OrganizationsService } from './organizations.service.js';

@Injectable()
export class LogosService {
	constructor(
		@Inject(STORAGE) private readonly storage: StorageAdapter,
		@InjectQueue(LOGO_QUEUE) private readonly queue: Queue<LogoJobData>,
		private readonly audit: AuditService,
		private readonly organizations: OrganizationsService
	) {}

	async upload(contentType: string | undefined, body: Buffer): Promise<OrganizationView> {
		const mime = assertLogo(contentType, body);
		const tx = RequestContext.tx();
		const scope = RequestContext.organization();
		const userId = RequestContext.get()!.userId!;
		const logoId = newId();
		const originalKey = logoKey(scope.organizationId, logoId, 'original');
		await this.storage.put(originalKey, body, mime);
		await tx.insert(organizationLogos).values({
			id: logoId,
			organizationId: scope.organizationId,
			originalKey,
			originalMime: mime,
			originalBytes: body.length,
			status: 'processing',
			createdBy: userId
		});
		await this.audit.record(tx, {
			actor: { type: 'user', userId, role: scope.role },
			organizationId: scope.organizationId,
			action: 'organization.logo.upload',
			objectType: 'organization_logo',
			objectId: logoId,
			after: { mime, bytes: body.length, status: 'processing' }
		});
		RequestContext.afterCommit(async () => {
			await this.queue.add('render', { organizationId: scope.organizationId, logoId }, { jobId: logoId });
		});
		return this.organizations.view(tx);
	}
}
