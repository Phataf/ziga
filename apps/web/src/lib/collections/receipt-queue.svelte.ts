/**
 * File d'envoi des justificatifs de dépense (lot 10 bis, étape 0), comme celle des scans du lot 08 bis : la photo ou le
 * PDF, pris hors ligne, est assemblé en un seul PDF sur l'appareil et gardé (IndexedDB). À la reconnexion il part :
 * fiche du document « Justificatif de dépense » (rattachée au bien, à l'unité et au bail de la dépense), envoi direct
 * au stockage, réception contrôlée par le serveur (type, taille, empreinte), puis rattachement à la dépense, une seule
 * fois. Sans justificatif, aucune retenue sur caution (règle 14).
 *
 * L'étape est gardée : un fichier déjà au stockage ne repart pas. Une dépense saisie hors ligne et pas encore reçue par
 * le serveur (EXPENSE_NOT_FOUND) n'est pas un refus : le rattachement est retenté. Tout autre refus reste affiché, avec
 * son motif, jusqu'au retrait du justificatif de la file.
 */
import type { DocumentView } from '@ziga/shared/documents';
import { ApiError, NetworkError } from '../auth/http';
import { organizations } from '../org/organizations.svelte';

const DB_NAME = 'ziga-expense-receipts';
const STORE = 'queue';
const RETRY_MS = 15_000;

export interface QueuedReceipt {
	/** Identifiant du document (fiche créée à l'envoi). */
	id: string;
	organizationId: string;
	expenseId: string;
	propertyId: string;
	unitId: string | null;
	leaseId: string | null;
	blob: Blob;
	fileName: string;
	/** `created` : fiche créée, fichier pas encore au stockage ; `uploaded` : au stockage ; `active` : reçu, reste le rattachement. */
	stage: 'queued' | 'created' | 'uploaded' | 'active';
	error: string | null;
	createdAt: number;
}

interface PresignedUpload {
	url: string;
	headers: Record<string, string>;
}

function open(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);
		request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	const db = await open();
	try {
		return await new Promise<T>((resolve, reject) => {
			const tx = db.transaction(STORE, mode);
			const request = fn(tx.objectStore(STORE));
			tx.oncomplete = () => resolve(request.result);
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
	} finally {
		db.close();
	}
}

async function put(upload: PresignedUpload, blob: Blob): Promise<void> {
	const response = await fetch(upload.url, { method: 'PUT', body: blob, headers: { 'content-type': 'application/pdf' } });
	if (!response.ok) throw new NetworkError();
}

class ExpenseReceiptQueue {
	/** Justificatifs en file, sans le fichier (affichage). */
	items = $state<Omit<QueuedReceipt, 'blob'>[]>([]);
	sending = $state<string | null>(null);
	#flushing: Promise<void> | null = null;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#listening = false;

	async start(): Promise<void> {
		if (typeof indexedDB === 'undefined') return;
		if (!this.#listening && typeof window !== 'undefined') {
			this.#listening = true;
			window.addEventListener('online', () => void this.flush());
		}
		await this.#reload();
		void this.flush();
	}

	async #reload(): Promise<QueuedReceipt[]> {
		const all = await run('readonly', (s) => s.getAll() as IDBRequest<QueuedReceipt[]>);
		this.items = all.sort((a, b) => a.createdAt - b.createdAt).map(({ blob: _b, ...rest }) => rest);
		return all;
	}

	/** Justificatif en file pour une dépense. */
	of(expenseId: string): Omit<QueuedReceipt, 'blob'> | undefined {
		return this.items.find((r) => r.expenseId === expenseId);
	}

	async add(receipt: Omit<QueuedReceipt, 'stage' | 'error' | 'createdAt'>): Promise<void> {
		await run('readwrite', (s) => s.put({ ...receipt, stage: 'queued', error: null, createdAt: Date.now() } satisfies QueuedReceipt));
		await this.#reload();
		void this.flush();
	}

	async remove(id: string): Promise<void> {
		await run('readwrite', (s) => s.delete(id));
		await this.#reload();
	}

	flush(): Promise<void> {
		this.#flushing ??= this.#flushOnce().finally(() => (this.#flushing = null));
		return this.#flushing;
	}

	async #save(receipt: QueuedReceipt): Promise<void> {
		await run('readwrite', (s) => s.put(receipt));
	}

	/** Une étape ; renvoie `false` si la dépense n'est pas encore sur le serveur (à retenter, sans erreur). */
	async #step(r: QueuedReceipt): Promise<boolean> {
		if (r.stage === 'queued') {
			const created = await organizations
				.call<{ document: DocumentView; upload: PresignedUpload }>('POST', '/documents', {
					id: r.id,
					type: 'expense_receipt',
					propertyId: r.propertyId,
					unitId: r.unitId,
					leaseId: r.leaseId,
					fileName: r.fileName,
					mimeType: 'application/pdf',
					byteSize: r.blob.size
				})
				.catch((error: unknown) => {
					// Réponse perdue : la fiche existe déjà (même identifiant), on reprend à l'envoi du fichier.
					if (error instanceof ApiError && error.code === 'CONFLICT') return null;
					throw error;
				});
			r.stage = 'created';
			await this.#save(r);
			if (created) {
				await put(created.upload, r.blob);
				r.stage = 'uploaded';
				await this.#save(r);
			}
		}
		if (r.stage === 'created') {
			await put(await organizations.call<PresignedUpload>('POST', `/documents/${r.id}/upload-url`), r.blob);
			r.stage = 'uploaded';
			await this.#save(r);
		}
		if (r.stage === 'uploaded') {
			const doc = await organizations.call<DocumentView>('POST', `/documents/${r.id}/uploaded`);
			if (doc.status !== 'active') throw new ApiError(400, 'DOCUMENT_REJECTED', doc.error ?? 'DOCUMENT_REJECTED');
			r.stage = 'active';
			await this.#save(r);
		}
		try {
			await organizations.call('POST', `/expenses/${r.expenseId}/document`, { documentId: r.id });
		} catch (error) {
			if (error instanceof ApiError && error.code === 'EXPENSE_NOT_FOUND') return false;
			throw error;
		}
		await run('readwrite', (s) => s.delete(r.id));
		return true;
	}

	async #flushOnce(): Promise<void> {
		if (typeof indexedDB === 'undefined') return;
		const all = await this.#reload();
		let retry = false;
		for (const receipt of all) {
			if (receipt.error) continue;
			if (receipt.organizationId !== organizations.activeId) {
				retry = true;
				continue;
			}
			this.sending = receipt.id;
			try {
				if (!(await this.#step(receipt))) retry = true;
			} catch (error) {
				if (error instanceof ApiError && error.status < 500 && error.status !== 401 && error.status !== 429) {
					await this.#save({ ...receipt, error: error.message });
				} else {
					retry = true;
					if (error instanceof NetworkError) break;
				}
			} finally {
				this.sending = null;
			}
		}
		await this.#reload();
		if (retry) this.#schedule();
	}

	#schedule(): void {
		if (this.#timer) return;
		this.#timer = setTimeout(() => {
			this.#timer = null;
			void this.flush();
		}, RETRY_MS);
	}

	/** Déconnexion : la file est effacée de l'appareil. */
	async clear(): Promise<void> {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
		this.items = [];
		if (typeof indexedDB === 'undefined') return;
		await run('readwrite', (s) => s.clear()).catch(() => undefined);
	}
}

export const expenseReceiptQueue = new ExpenseReceiptQueue();
