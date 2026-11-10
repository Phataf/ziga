/**
 * Photos des biens et des unités (lot 07, étape 3) : service public du module properties, utilisé par ses routes et
 * par l'envoi des modifications de l'appareil.
 *
 * Chemin d'une photo :
 *   1. l'appareil l'annonce (type, taille ≤ 10 Mo), hors ligne au besoin : la fiche naît « en attente » ; la base
 *      limite à 15 photos par unité ;
 *   2. en ligne, il demande une URL d'envoi : le serveur décide la clé et signe le type et la taille (10 minutes) ;
 *   3. il envoie le fichier directement au stockage, puis le signale : la tâche du worker contrôle le fichier réel,
 *      produit les variantes WebP sans EXIF et efface l'original.
 * Agent de terrain : seulement les photos de ses unités affectées (jamais celles d'un bien entier).
 */
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import {
	MEDIA_VARIANT_SIZES,
	mediaVariantPath,
	UPLOAD_URL_TTL_SECONDS,
	type CreateMediaData,
	type MediaVariantSize,
	type MediaView,
	type UpdateMediaInput
} from '@ziga/shared/properties';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { AppError } from '../../common/app-error.js';
import { RequestContext } from '../../common/request-context.js';
import { media } from '../../db/schema/properties.js';
import { MEDIA_QUEUE, type MediaJobData } from '../../jobs/queues.js';
import { STORAGE, type PresignedUpload, type StorageAdapter } from '../../storage/storage.js';
import { AuditService, diff } from '../audit/audit.service.js';
import { mediaOriginalKey, mediaVariantKey } from './media-processing.js';
import { PropertiesService } from './properties.service.js';

type MediaRow = typeof media.$inferSelect;

export function mediaView(m: MediaRow): MediaView {
	return {
		id: m.id,
		propertyId: m.propertyId,
		unitId: m.unitId,
		mimeType: m.mimeType,
		byteSize: m.byteSize,
		position: m.position,
		caption: m.caption,
		status: m.status,
		error: m.error,
		width: m.width,
		height: m.height,
		variants:
			m.status === 'ready' && m.variantsKey
				? (Object.fromEntries(MEDIA_VARIANT_SIZES.map((s) => [s, mediaVariantPath(m.variantsKey!, s)])) as Record<MediaVariantSize, string>)
				: null,
		createdAt: m.createdAt.toISOString(),
		processedAt: m.processedAt?.toISOString() ?? null
	};
}

const NOT_FOUND = () => new AppError('MEDIA_NOT_FOUND', 'Photo introuvable.', 404);

@Injectable()
export class MediaService {
	constructor(
		private readonly audit: AuditService,
		private readonly properties: PropertiesService,
		@Inject(STORAGE) private readonly storage: StorageAdapter,
		@InjectQueue(MEDIA_QUEUE) private readonly queue: Queue<MediaJobData>
	) {}

	private context() {
		const scope = RequestContext.organization();
		const userId = RequestContext.get()!.userId!;
		return {
			tx: RequestContext.tx(),
			organizationId: scope.organizationId,
			role: scope.role,
			userId,
			actor: { type: 'user' as const, userId, role: scope.role }
		};
	}

	/** Objet de la photo : bien et unité de l'organisation ; pour l'agent de terrain, une unité qui lui est affectée. */
	private async checkObject(propertyId: string, unitId: string | null): Promise<void> {
		const { role } = this.context();
		if (role === 'field_agent' && !unitId) throw new AppError('FORBIDDEN_ACTION', 'Un agent de terrain photographie ses unités.', 403);
		if (unitId) {
			const unit = await this.properties.getUnit(unitId);
			if (unit.propertyId !== propertyId) throw new AppError('UNIT_NOT_FOUND', 'Unité introuvable.', 404);
		} else {
			await this.properties.get(propertyId);
		}
	}

	private async row(id: string, lock = false): Promise<MediaRow> {
		const { tx, organizationId } = this.context();
		const q = tx
			.select()
			.from(media)
			.where(and(eq(media.organizationId, organizationId), eq(media.id, id)))
			.limit(1);
		const [row] = lock ? await q.for('update') : await q;
		if (!row) throw NOT_FOUND();
		try {
			await this.checkObject(row.propertyId, row.unitId);
		} catch {
			throw NOT_FOUND();
		}
		return row;
	}

	async get(id: string): Promise<MediaView> {
		return mediaView(await this.row(id));
	}

	/** Annonce d'une photo (type, taille) ; elle naît en attente de son fichier. 15 au plus par unité (base). */
	async create(input: CreateMediaData): Promise<MediaView> {
		const { tx, organizationId, actor, userId } = this.context();
		await this.checkObject(input.propertyId, input.unitId);
		const exists = await tx.select({ id: media.id }).from(media).where(eq(media.id, input.id)).limit(1);
		if (exists.length) throw new AppError('CONFLICT', 'Cette photo existe déjà.', 409);
		const [row] = await tx
			.insert(media)
			.values({
				id: input.id,
				organizationId,
				propertyId: input.propertyId,
				unitId: input.unitId,
				kind: 'photo',
				mimeType: input.mimeType,
				byteSize: input.byteSize,
				position: input.position,
				caption: input.caption,
				status: 'pending',
				uploadedBy: userId
			})
			.returning();
		await this.audit.record(tx, {
			actor,
			organizationId,
			action: 'media.create',
			objectType: 'media',
			objectId: input.id,
			after: { propertyId: input.propertyId, unitId: input.unitId, mimeType: input.mimeType, byteSize: input.byteSize, status: 'pending' }
		});
		return mediaView(row!);
	}

	/** URL d'envoi : clé décidée par le serveur ; type et taille annoncés signés ; 10 minutes. */
	async uploadUrl(id: string): Promise<PresignedUpload> {
		const { tx, organizationId } = this.context();
		const row = await this.row(id, true);
		if (row.status !== 'pending') throw new AppError('MEDIA_NOT_PENDING', 'Cette photo a déjà été envoyée.', 409, { status: row.status });
		const key = row.storageKey ?? mediaOriginalKey(organizationId, id);
		if (!row.storageKey) {
			await tx
				.update(media)
				.set({ storageKey: key, updatedAt: new Date() })
				.where(and(eq(media.organizationId, organizationId), eq(media.id, id)));
		}
		return this.storage.presignPut(key, {
			contentType: row.mimeType,
			contentLength: row.byteSize,
			expiresInSeconds: UPLOAD_URL_TTL_SECONDS
		});
	}

	/** Fichier envoyé : la photo passe en traitement ; la tâche part après la validation. */
	async uploaded(id: string): Promise<MediaView> {
		const { tx, organizationId, actor } = this.context();
		const row = await this.row(id, true);
		if (row.status !== 'pending') return mediaView(row);
		if (!row.storageKey || !(await this.storage.stat(row.storageKey))) {
			throw new AppError('MEDIA_FILE_MISSING', 'Le fichier n’est pas encore arrivé : renvoyez-le.', 409);
		}
		const now = new Date();
		const [updated] = await tx
			.update(media)
			.set({ status: 'processing', uploadedAt: now, updatedAt: now })
			.where(and(eq(media.organizationId, organizationId), eq(media.id, id)))
			.returning();
		await this.audit.record(tx, {
			actor,
			organizationId,
			action: 'media.upload',
			objectType: 'media',
			objectId: id,
			before: { status: 'pending' },
			after: { status: 'processing' }
		});
		RequestContext.afterCommit(async () => {
			await this.queue.add('process', { organizationId, mediaId: id }, { jobId: id });
		});
		return mediaView(updated!);
	}

	/** Légende et ordre (galerie réordonnée). */
	async update(id: string, input: UpdateMediaInput): Promise<MediaView> {
		const { tx, organizationId, actor } = this.context();
		const row = await this.row(id, true);
		if (row.status === 'removed') throw new AppError('MEDIA_REMOVED', 'Cette photo a été retirée.', 409);
		const before = { caption: row.caption, position: row.position };
		const next = { caption: input.caption === undefined ? row.caption : (input.caption ?? null), position: input.position ?? row.position };
		const changes = diff(before, next);
		if (!changes) return mediaView(row);
		const [updated] = await tx
			.update(media)
			.set({ ...next, updatedAt: new Date() })
			.where(and(eq(media.organizationId, organizationId), eq(media.id, id)))
			.returning();
		await this.audit.record(tx, { actor, organizationId, action: 'media.update', objectType: 'media', objectId: id, ...changes });
		return mediaView(updated!);
	}

	/** Retrait : la fiche reste (statut « retirée ») ; ses fichiers sont effacés après la validation. */
	async remove(id: string): Promise<MediaView> {
		const { tx, organizationId, actor } = this.context();
		const row = await this.row(id, true);
		if (row.status === 'removed') return mediaView(row);
		const now = new Date();
		const [updated] = await tx
			.update(media)
			.set({ status: 'removed', removedAt: now, updatedAt: now })
			.where(and(eq(media.organizationId, organizationId), eq(media.id, id)))
			.returning();
		await this.audit.record(tx, {
			actor,
			organizationId,
			action: 'media.remove',
			objectType: 'media',
			objectId: id,
			before: { status: row.status },
			after: { status: 'removed' }
		});
		const keys = [
			...(row.storageKey && row.status !== 'ready' && row.status !== 'rejected' ? [row.storageKey] : []),
			...(row.variantsKey ? MEDIA_VARIANT_SIZES.map((s) => mediaVariantKey(row.variantsKey!, s)) : [])
		];
		RequestContext.afterCommit(async () => {
			for (const key of keys) await this.storage.delete(key);
		});
		return mediaView(updated!);
	}
}
