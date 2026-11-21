/**
 * Pièces de la sortie déposées en ligne par la gestion (lot 10 bis, étape 4) : preuve du congé, devis ou facture d'une
 * réparation, accord écrit, issue d'une contestation. Photos et PDF réunis en un seul PDF sur l'appareil (même fonction
 * que le scan d'un contrat), puis fiche, envoi direct au stockage et réception contrôlée par le serveur ; le document
 * rattaché au bail est renvoyé pour être cité par l'action (règle 14 : sans justificatif, aucune retenue).
 */
import type { DocumentView } from '@ziga/shared/documents';
import { newId } from '@ziga/shared/ids';
import { ApiError, NetworkError } from '../auth/http';
import { receiptPart } from '../collections/receipt';
import { assembleScanPdf } from '../contracts/scan';
import { organizations } from '../org/organizations.svelte';

export type ExitDocumentType = 'notice_proof' | 'repair_quote' | 'agreement_document' | 'settlement_outcome';

/** Assemblage local (photos réduites, PDF) en un PDF : aussi utilisé hors ligne pour le scan d'un état des lieux. */
export async function assemblePdf(files: readonly File[], title: string): Promise<Blob> {
	const pdf = await assembleScanPdf(await Promise.all(files.map(receiptPart)), title);
	return new Blob([pdf as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
}

export async function uploadExitDocument(
	type: ExitDocumentType,
	subject: { leaseId: string; propertyId?: string | null; unitId?: string | null },
	files: readonly File[],
	title: string
): Promise<string> {
	const blob = await assemblePdf(files, title);
	const id = newId();
	const created = await organizations.call<{ document: DocumentView; upload: { url: string; headers: Record<string, string> } }>('POST', '/documents', {
		id,
		type,
		leaseId: subject.leaseId,
		propertyId: subject.propertyId ?? null,
		unitId: subject.unitId ?? null,
		fileName: `${title}.pdf`,
		mimeType: 'application/pdf',
		byteSize: blob.size
	});
	const response = await fetch(created.upload.url, { method: 'PUT', body: blob, headers: { 'content-type': 'application/pdf' } });
	if (!response.ok) throw new NetworkError();
	const doc = await organizations.call<DocumentView>('POST', `/documents/${id}/uploaded`);
	if (doc.status !== 'active') throw new ApiError(400, 'DOCUMENT_REJECTED', doc.error ?? 'Document refusé.');
	return id;
}

/** Consultation d'un justificatif : URL signée de courte durée, journalisée (règle 11). */
export async function openDocument(documentId: string): Promise<void> {
	const { url } = await organizations.call<{ url: string }>('POST', `/documents/${documentId}/download`);
	window.open(url, '_blank', 'noopener');
}
