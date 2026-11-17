/**
 * Assemblage du justificatif d'une dépense (lot 10 bis, étape 0) : photos réduites en JPEG (métadonnées retirées) et
 * PDF, réunis en un seul PDF par la même fonction que le scan d'un contrat (pdf-lib chargé à la demande).
 */
import { assembleScanPdf, type ScanPart } from '../contracts/scan';
import { compressPhoto } from '../properties/photos';

export async function receiptPart(file: File): Promise<ScanPart> {
	if (file.type === 'application/pdf') return { type: 'application/pdf', bytes: new Uint8Array(await file.arrayBuffer()) };
	if (!file.type.startsWith('image/')) throw Object.assign(new Error('UNSUPPORTED'), { code: 'UNSUPPORTED' });
	const jpeg = await compressPhoto(file).catch(() => {
		throw Object.assign(new Error('UNREADABLE'), { code: 'UNREADABLE' });
	});
	return { type: 'image/jpeg', bytes: new Uint8Array(await jpeg.arrayBuffer()) };
}

export async function assembleReceipt(files: readonly File[]): Promise<Blob> {
	const pdf = await assembleScanPdf(await Promise.all(files.map(receiptPart)), 'Justificatif de dépense');
	return new Blob([pdf as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
}
