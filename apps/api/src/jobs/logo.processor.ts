import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { Job } from 'bullmq';
import { desc, eq } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { DatabaseService } from '../db/database.module.js';
import { organizationLogos, organizations } from '../db/schema/organizations.js';
import { AuditService } from '../modules/audit/audit.service.js';
import { logoKey, LOGO_VARIANTS, renderLogo } from '../modules/organizations/logo-files.js';
import { STORAGE, type StorageAdapter } from '../storage/storage.js';
import { LOGO_QUEUE, type LogoJobData } from './queues.js';

/**
 * Traitement d'un logo envoyé (worker seulement), dans le contexte de son organisation :
 * versions WebP et PNG, puis le logo devient celui de l'organisation s'il est le plus récent prêt.
 * Une image illisible marque la version « en échec » sans nouvel essai.
 */
@Processor(LOGO_QUEUE)
export class LogoProcessor extends WorkerHost {
	constructor(
		private readonly database: DatabaseService,
		private readonly audit: AuditService,
		@Inject(STORAGE) private readonly storage: StorageAdapter,
		private readonly logger: PinoLogger
	) {
		super();
		logger.setContext(LogoProcessor.name);
	}

	async process(job: Job<LogoJobData>): Promise<{ status: string }> {
		const { organizationId, logoId } = job.data;
		return this.database.withOrganization(organizationId, async (tx) => {
			const [logo] = await tx.select().from(organizationLogos).where(eq(organizationLogos.id, logoId)).limit(1).for('update');
			if (!logo || logo.status !== 'processing') return { status: logo?.status ?? 'missing' };
			let rendered: Awaited<ReturnType<typeof renderLogo>>;
			try {
				rendered = await renderLogo(await this.storage.get(logo.originalKey));
			} catch (error) {
				this.logger.warn({ logoId, err: error }, 'Logo illisible');
				await tx
					.update(organizationLogos)
					.set({ status: 'failed', error: 'IMAGE_INVALID', processedAt: new Date() })
					.where(eq(organizationLogos.id, logoId));
				await this.audit.record(tx, {
					actor: { type: 'system' },
					organizationId,
					action: 'organization.logo.reject',
					objectType: 'organization_logo',
					objectId: logoId,
					before: { status: 'processing' },
					after: { status: 'failed' },
					origin: 'job'
				});
				return { status: 'failed' };
			}
			await this.storage.put(logoKey(organizationId, logoId, 'web.webp'), rendered.web, LOGO_VARIANTS['web.webp']);
			await this.storage.put(logoKey(organizationId, logoId, 'print.png'), rendered.print, LOGO_VARIANTS['print.png']);
			await tx
				.update(organizationLogos)
				.set({
					status: 'ready',
					webKey: logoKey(organizationId, logoId, 'web.webp'),
					printKey: logoKey(organizationId, logoId, 'print.png'),
					width: rendered.width,
					height: rendered.height,
					processedAt: new Date()
				})
				.where(eq(organizationLogos.id, logoId));
			// Le plus récent envoi prêt devient le logo de l'organisation ; l'ancien reste stocké (D29).
			const [newest] = await tx
				.select({ id: organizationLogos.id })
				.from(organizationLogos)
				.where(eq(organizationLogos.status, 'ready'))
				.orderBy(desc(organizationLogos.createdAt), desc(organizationLogos.id))
				.limit(1);
			const [org] = await tx.select({ logoId: organizations.logoId }).from(organizations).limit(1).for('update');
			if (newest?.id === logoId && org?.logoId !== logoId) {
				await tx.update(organizations).set({ logoId, updatedAt: new Date() }).where(eq(organizations.id, organizationId));
				await this.audit.record(tx, {
					actor: { type: 'system' },
					organizationId,
					action: 'organization.logo.activate',
					objectType: 'organization',
					objectId: organizationId,
					before: { logoId: org?.logoId ?? null },
					after: { logoId },
					origin: 'job'
				});
			}
			return { status: 'ready' };
		});
	}
}
