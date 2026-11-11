/**
 * Photos sur l'appareil (lot 07) : compression avant envoi et file d'envoi hors ligne. Fonctions pures testées ici ;
 * l'accès au canevas et à IndexedDB reste dans le navigateur.
 *
 * - Compression : largeur et hauteur ramenées à 1600 px au plus, orientation appliquée, JPEG ; les métadonnées (EXIF,
 *   position GPS) ne survivent pas au canevas. Le serveur refait le travail de toute façon (seconde barrière).
 * - 10 Mo au plus avant compression (prompt du lot 07) ; une image que l'appareil ne sait pas lire (HEIC hors Safari)
 *   est refusée avec un message clair.
 */
import { MAX_UPLOAD_BYTES } from '@ziga/shared/properties';

export const PHOTO_MAX_SIDE = 1600;
export const PHOTO_QUALITY = 0.82;

/** Dimensions après réduction : le plus grand côté à `max` au plus, sans jamais agrandir. */
export function fitWithin(width: number, height: number, max = PHOTO_MAX_SIDE): { width: number; height: number } {
	const scale = Math.min(1, max / Math.max(width, height));
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export type CompressError = 'TOO_LARGE' | 'UNREADABLE';

/** Fichier refusé avant toute lecture : plus de 10 Mo. */
export function precheck(file: { size: number }): CompressError | null {
	return file.size > MAX_UPLOAD_BYTES ? 'TOO_LARGE' : null;
}

/** Photo compressée dans le navigateur : JPEG de 1600 px au plus. */
export async function compressPhoto(file: Blob): Promise<Blob> {
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
	} catch {
		throw Object.assign(new Error('UNREADABLE'), { code: 'UNREADABLE' as CompressError });
	}
	const size = fitWithin(bitmap.width, bitmap.height);
	const canvas = new OffscreenCanvas(size.width, size.height);
	const context = canvas.getContext('2d');
	if (!context) throw Object.assign(new Error('UNREADABLE'), { code: 'UNREADABLE' as CompressError });
	context.drawImage(bitmap, 0, 0, size.width, size.height);
	bitmap.close();
	return canvas.convertToBlob({ type: 'image/jpeg', quality: PHOTO_QUALITY });
}
