/**
 * Traitement d'une photo reçue (lot 07, étape 3), appelé par la tâche BullMQ du worker dans le contexte de son
 * organisation. Seconde barrière après l'URL signée : taille réelle (10 Mo au plus, celle annoncée), type réel (celui
 * annoncé), image lisible. Puis variantes WebP 320, 800 et 1600 (orientation appliquée, jamais agrandie, aucune
 * métadonnée : ni EXIF ni position GPS), servies sous une clé aléatoire de 128 bits distincte de l'identifiant.
 * L'original n'est jamais servi et il est effacé après traitement, accepté ou refusé.
 *
 * Clés de stockage :
 *   media/<organization_id>/<media_id>/original    (privé, effacé après traitement)
 *   media-public/<variants_key>/<taille>.webp      (public, jamais réécrit)
 */
import { randomBytes } from 'node:crypto';
import { MAX_UPLOAD_BYTES, MEDIA_VARIANT_SIZES, type MediaVariantSize } from '@ziga/shared/properties';
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { detectFileType, matchesDeclared } from '../../common/file-types.js';
import type { Tx } from '../../db/database.js';
import { media } from '../../db/schema/properties.js';
import type { StorageAdapter } from '../../storage/storage.js';
import type { AuditService } from '../audit/audit.service.js';

export function mediaOriginalKey(organizationId: string, mediaId: string): string {
	return `media/${organizationId}/${mediaId}/original`;
}

export function mediaVariantKey(variantsKey: string, size: MediaVariantSize): string {
	return `media-public/${variantsKey}/${size}.webp`;
}

/** Clé publique des variantes : 128 bits aléatoires (22 caractères base64url). */
export function newVariantsKey(): string {
	return randomBytes(16).toString('base64url');
}

/** Variantes WebP : orientation EXIF appliquée, puis métadonnées retirées (comportement par défaut de sharp). */
export async function renderPhoto(
	original: Buffer
): Promise<{ variants: { size: MediaVariantSize; body: Buffer }[]; width: number; height: number }> {
	const variants: { size: MediaVariantSize; body: Buffer }[] = [];
	let width = 0;
	let height = 0;
	for (const size of MEDIA_VARIANT_SIZES) {
		const { data, info } = await sharp(original, { limitInputPixels: 60_000_000, failOn: 'error' })
			.rotate()
			.resize(size, size, { fit: 'inside', withoutEnlargement: true })
			.webp({ quality: size === 320 ? 70 : 78, effort: 4 })
			.toBuffer({ resolveWithObject: true });
		variants.push({ size, body: data });
		if (size === 1600) {
			width = info.width;
			height = info.height;
		}
	}
	return { variants, width, height };
}

export interface ProcessResult {
	status: 'ready' | 'rejected' | 'skipped';
	error?: string;
	/** Clé de l'original à effacer une fois la transaction validée. */
	deleteKey?: string;
}

/** Une photo « en traitement » devient prête (variantes écrites) ou refusée (motif) ; son original sera effacé. */
export async function processMediaUpload(
	tx: Tx,
	deps: { storage: StorageAdapter; audit: AuditService },
	organizationId: string,
	mediaId: string
): Promise<ProcessResult> {
	const [row] = await tx
		.select()
		.from(media)
		.where(and(eq(media.organizationId, organizationId), eq(media.id, mediaId)))
		.limit(1)
		.for('update');
	if (!row || row.status !== 'processing' || !row.storageKey) return { status: 'skipped' };
	const key = row.storageKey;

	const reject = async (error: string): Promise<ProcessResult> => {
		await tx
			.update(media)
			.set({ status: 'rejected', error, processedAt: new Date(), updatedAt: new Date() })
			.where(and(eq(media.organizationId, organizationId), eq(media.id, mediaId)));
		await deps.audit.record(tx, {
			actor: { type: 'system' },
			organizationId,
			action: 'media.reject',
			objectType: 'media',
			objectId: mediaId,
			before: { status: 'processing' },
			after: { status: 'rejected', error },
			origin: 'job'
		});
		return { status: 'rejected', error, deleteKey: key };
	};

	const found = await deps.storage.stat(key);
	if (!found) return reject('FILE_MISSING');
	if (found.size > MAX_UPLOAD_BYTES || found.size !== row.byteSize) return reject('FILE_SIZE');
	const original = await deps.storage.get(key);
	if (original.length !== row.byteSize) return reject('FILE_SIZE');
	if (!matchesDeclared(row.mimeType, detectFileType(original))) return reject('FILE_TYPE');
	let rendered: Awaited<ReturnType<typeof renderPhoto>>;
	try {
		rendered = await renderPhoto(original);
	} catch {
		// Image illisible (HEIC sans décodeur, fichier tronqué) : l'appareil convertit en JPEG avant l'envoi.
		return reject('FILE_UNREADABLE');
	}
	const variantsKey = newVariantsKey();
	for (const v of rendered.variants) await deps.storage.put(mediaVariantKey(variantsKey, v.size), v.body, 'image/webp');
	await tx
		.update(media)
		.set({
			status: 'ready',
			variantsKey,
			width: rendered.width,
			height: rendered.height,
			error: null,
			processedAt: new Date(),
			updatedAt: new Date()
		})
		.where(and(eq(media.organizationId, organizationId), eq(media.id, mediaId)));
	await deps.audit.record(tx, {
		actor: { type: 'system' },
		organizationId,
		action: 'media.ready',
		objectType: 'media',
		objectId: mediaId,
		before: { status: 'processing' },
		after: { status: 'ready', width: rendered.width, height: rendered.height },
		origin: 'job'
	});
	return { status: 'ready', deleteKey: key };
}
