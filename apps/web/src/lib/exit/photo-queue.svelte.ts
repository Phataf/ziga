/**
 * File des photos et du scan d'un état des lieux (lot 10 bis, étape 4), comme celle des justificatifs de dépense : la
 * photo prise sur place, hors ligne, est réduite en JPEG (métadonnées retirées) et gardée sur l'appareil (IndexedDB).
 * À la reconnexion elle part par la route de l'état des lieux (`inspection.create`, l'agent de terrain sur ses unités) :
 * fiche, envoi direct au stockage, réception contrôlée par le serveur. Le scan signé suit le même chemin, puis signe
 * l'état des lieux (« signature manuscrite, scan déposé », D21).
 *
 * L'étape est gardée : un fichier déjà au stockage ne repart pas. Un état des lieux ou une ligne créés hors ligne et
 * pas encore reçus par le serveur ne sont pas un refus : l'envoi est retenté. Tout autre refus reste affiché, avec son
 * motif, jusqu'au retrait de la photo de la file. La file est vidée à la déconnexion.
 */
import type { DocumentView } from '@ziga/shared/documents';
import { ApiError, NetworkError } from '../auth/http';
import { organizations } from '../org/organizations.svelte';

const DB_NAME = 'ziga-inspection-photos';
const STORE = 'queue';
const RETRY_MS = 15_000;
/** Pas encore sur le serveur (créé hors ligne, synchronisation en cours) : à retenter, sans erreur. */
const NOT_YET = new Set(['INSPECTION_NOT_FOUND', 'INSPECTION_ITEM_NOT_FOUND']);

export interface QueuedInspectionFile {
	/** Identifiant du document (fiche créée à l'envoi). */
	id: string;
	organizationId: string;
	inspectionId: string;
	/** Ligne photographiée ; `null` pour le scan signé. */
	inspectionItemId: string | null;
	type: 'inspection_photo' | 'inspection_scan';
	blob: Blob;
	fileName: string;
	mimeType: 'image/jpeg' | 'application/pdf';
	stage: 'queued' | 'created' | 'uploaded' | 'active';
	error: string | null;
	createdAt: number;
}

export type QueuedView = Omit<QueuedInspectionFile, 'blob'>;

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

async function put(upload: PresignedUpload, file: QueuedInspectionFile): Promise<void> {
	const response = await fetch(upload.url, { method: 'PUT', body: file.blob, headers: { 'content-type': file.mimeType } });
	if (!response.ok) throw new NetworkError();
}

class InspectionPhotoQueue {
	/** Fichiers en file, sans le contenu (affichage). */
	items = $state<QueuedView[]>([]);
	/** Aperçus des photos encore sur l'appareil (URL locales). */
	previews = $state<Record<string, string>>({});
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

	async #reload(): Promise<QueuedInspectionFile[]> {
		const all = await run('readonly', (s) => s.getAll() as IDBRequest<QueuedInspectionFile[]>);
		all.sort((a, b) => a.createdAt - b.createdAt);
		const previews: Record<string, string> = {};
		for (const f of all) {
			if (f.type !== 'inspection_photo') continue;
			previews[f.id] = this.previews[f.id] ?? (typeof URL.createObjectURL === 'function' ? URL.createObjectURL(f.blob) : '');
		}
		for (const [id, url] of Object.entries(this.previews)) if (!previews[id] && url) URL.revokeObjectURL(url);
		this.previews = previews;
		this.items = all.map(({ blob: _b, ...rest }) => rest);
		return all;
	}

	/** Photos en file d'une ligne. */
	of(itemId: string): QueuedView[] {
		return this.items.filter((f) => f.inspectionItemId === itemId);
	}

	/** Scan en file d'un état des lieux. */
	scanOf(inspectionId: string): QueuedView | undefined {
		return this.items.find((f) => f.inspectionId === inspectionId && f.type === 'inspection_scan');
	}

	async add(file: Omit<QueuedInspectionFile, 'stage' | 'error' | 'createdAt'>): Promise<void> {
		await run('readwrite', (s) => s.put({ ...file, stage: 'queued', error: null, createdAt: Date.now() } satisfies QueuedInspectionFile));
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

	async #save(file: QueuedInspectionFile): Promise<void> {
		await run('readwrite', (s) => s.put(file));
	}

	/** Une étape ; renvoie `false` si l'état des lieux (ou la ligne) n'est pas encore sur le serveur. */
	async #step(f: QueuedInspectionFile): Promise<boolean> {
		const base = `/inspections/${f.inspectionId}/documents`;
		try {
			if (f.stage === 'queued') {
				const created = await organizations
					.call<{ document: DocumentView; upload: PresignedUpload }>('POST', base, {
						id: f.id,
						type: f.type,
						inspectionItemId: f.inspectionItemId,
						fileName: f.fileName,
						mimeType: f.mimeType,
						byteSize: f.blob.size,
						// Heure de la prise de vue : une photo prise avant la signature est reçue même après elle.
						takenAt: f.type === 'inspection_photo' ? new Date(f.createdAt).toISOString() : null
					})
					.catch((error: unknown) => {
						// Réponse perdue : la fiche existe déjà (même identifiant), on reprend à l'envoi du fichier.
						if (error instanceof ApiError && error.code === 'CONFLICT') return null;
						throw error;
					});
				f.stage = 'created';
				await this.#save(f);
				if (created) {
					await put(created.upload, f);
					f.stage = 'uploaded';
					await this.#save(f);
				}
			}
			if (f.stage === 'created') {
				await put(await organizations.call<PresignedUpload>('POST', `${base}/${f.id}/upload-url`), f);
				f.stage = 'uploaded';
				await this.#save(f);
			}
			if (f.stage === 'uploaded') {
				const doc = await organizations.call<DocumentView>('POST', `${base}/${f.id}/uploaded`);
				if (doc.status !== 'active') throw new ApiError(400, 'DOCUMENT_REJECTED', doc.error ?? 'DOCUMENT_REJECTED');
				f.stage = 'active';
				await this.#save(f);
			}
			if (f.type === 'inspection_scan') await organizations.call('POST', `/inspections/${f.inspectionId}/sign`, { scanDocumentId: f.id });
		} catch (error) {
			if (error instanceof ApiError && NOT_YET.has(error.code)) return false;
			throw error;
		}
		await run('readwrite', (s) => s.delete(f.id));
		return true;
	}

	async #flushOnce(): Promise<void> {
		if (typeof indexedDB === 'undefined') return;
		const all = await this.#reload();
		let retry = false;
		for (const file of all) {
			if (file.error) continue;
			if (file.organizationId !== organizations.activeId) {
				retry = true;
				continue;
			}
			this.sending = file.id;
			try {
				if (!(await this.#step(file))) retry = true;
			} catch (error) {
				if (error instanceof ApiError && error.status < 500 && error.status !== 401 && error.status !== 429) {
					await this.#save({ ...file, error: error.message });
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
		for (const url of Object.values(this.previews)) if (url) URL.revokeObjectURL(url);
		this.previews = {};
		this.items = [];
		if (typeof indexedDB === 'undefined') return;
		await run('readwrite', (s) => s.clear()).catch(() => undefined);
	}
}

export const inspectionPhotoQueue = new InspectionPhotoQueue();
