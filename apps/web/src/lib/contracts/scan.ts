/**
 * Scan du contrat signé, assemblé sur l'appareil (lot 08 bis, docs/UX.md §10) : photos des pages (JPEG ou PNG, déjà
 * compressées par `compressPhoto`) et PDF éventuels réunis en un seul PDF, une photo par page A4, dans l'ordre choisi.
 *
 * pdf-lib est chargé à la demande (`import()`), dans l'application seulement : jamais dans la vitrine (point 2 du
 * porteur). Le serveur contrôle de nouveau le fichier reçu (type, taille, empreinte).
 */

export type ScanPartType = 'application/pdf' | 'image/jpeg' | 'image/png';

export interface ScanPart {
	type: ScanPartType;
	bytes: Uint8Array;
}

/** Limite du dépôt (packages/shared, contractUploadSchema) : 10 Mo. */
export const SCAN_MAX_BYTES = 10 * 1024 * 1024;

/** A4 en points PDF. */
const A4 = { width: 595.28, height: 841.89 };
/** Marge blanche autour de chaque photo. */
const MARGIN = 18;

export type ScanError = 'EMPTY' | 'UNSUPPORTED' | 'UNREADABLE' | 'TOO_LARGE';

function fail(code: ScanError): never {
	throw Object.assign(new Error(code), { code });
}

/** Taille d'une image ramenée à la page (portrait ou paysage selon l'image), sans jamais l'agrandir au-delà. */
export function placeOnPage(
	width: number,
	height: number
): { page: [number, number]; x: number; y: number; width: number; height: number } {
	const landscape = width > height;
	const page: [number, number] = landscape ? [A4.height, A4.width] : [A4.width, A4.height];
	const scale = Math.min((page[0] - 2 * MARGIN) / width, (page[1] - 2 * MARGIN) / height);
	const w = width * scale;
	const h = height * scale;
	return { page, x: (page[0] - w) / 2, y: (page[1] - h) / 2, width: w, height: h };
}

/** Un seul PDF, dans l'ordre des pièces ; titre et producteur neutres (aucune donnée personnelle dans les métadonnées). */
export async function assembleScanPdf(parts: readonly ScanPart[]): Promise<Uint8Array> {
	if (!parts.length) fail('EMPTY');
	const { PDFDocument } = await import('pdf-lib');
	const out = await PDFDocument.create();
	out.setTitle('Contrat signé (scan)');
	out.setProducer('Ziga');
	out.setCreator('Ziga');
	for (const part of parts) {
		try {
			if (part.type === 'application/pdf') {
				const source = await PDFDocument.load(part.bytes);
				for (const page of await out.copyPages(source, source.getPageIndices())) out.addPage(page);
			} else if (part.type === 'image/jpeg' || part.type === 'image/png') {
				const image = part.type === 'image/jpeg' ? await out.embedJpg(part.bytes) : await out.embedPng(part.bytes);
				const at = placeOnPage(image.width, image.height);
				out.addPage(at.page).drawImage(image, { x: at.x, y: at.y, width: at.width, height: at.height });
			} else {
				fail('UNSUPPORTED');
			}
		} catch (error) {
			if ((error as { code?: string }).code) throw error;
			fail('UNREADABLE');
		}
	}
	const bytes = await out.save({ useObjectStreams: true });
	if (bytes.byteLength > SCAN_MAX_BYTES) fail('TOO_LARGE');
	return bytes;
}
