/**
 * File d'envoi des scans signés (lot 08 bis), comme celle des photos (lot 07) : le scan pris hors ligne est assemblé en
 * PDF sur l'appareil et gardé (IndexedDB) avec les dates de signature ; à la reconnexion il part : fiche du document
 * et URL signée, envoi direct au stockage, puis enregistrement de la signature. Le serveur décide (version figée, bail
 * inchangé, dates) ; un refus reste affiché sur le contrat, avec son motif, jusqu'à ce qu'on retire le scan de la file.
 *
 * L'étape est gardée : un scan déjà envoyé au stockage ne repart pas, seule la signature est redemandée.
 */
import type { ContractDetailView, ContractParty } from '@ziga/shared/contracts';
import type { DocumentView } from '@ziga/shared/documents';
import { ApiError, NetworkError } from '../auth/http';
import { organizations } from '../org/organizations.svelte';

const DB_NAME = 'ziga-scans';
const STORE = 'queue';
const RETRY_MS = 15_000;

export interface QueuedScan {
	/** Identifiant du document (fiche créée à l'envoi). */
	id: string;
	organizationId: string;
	contractId: string;
	/** Version figée attendue : si le contrat a changé entre-temps, le serveur refuse. */
	expectedVersion: number;
	signedOn: Record<ContractParty, string | null>;
	blob: Blob;
	fileName: string;
	/** `uploaded` : le fichier est au stockage, reste la signature. */
	stage: 'queued' | 'uploaded';
	/** Refus du serveur (motif), le scan reste en file jusqu'à son retrait. */
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

class ScanQueue {
	/** Scans en file, sans le fichier (affichage). */
	items = $state<Omit<QueuedScan, 'blob'>[]>([]);
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

	async #reload(): Promise<QueuedScan[]> {
		const all = await run('readonly', (s) => s.getAll() as IDBRequest<QueuedScan[]>);
		this.items = all.sort((a, b) => a.createdAt - b.createdAt).map(({ blob: _b, ...rest }) => rest);
		return all;
	}

	/** Scans en file pour un contrat. */
	of(contractId: string): Omit<QueuedScan, 'blob'>[] {
		return this.items.filter((s) => s.contractId === contractId);
	}

	async add(scan: Omit<QueuedScan, 'stage' | 'error' | 'createdAt'>): Promise<void> {
		await run('readwrite', (s) => s.put({ ...scan, stage: 'queued', error: null, createdAt: Date.now() } satisfies QueuedScan));
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

	async #put(scan: QueuedScan): Promise<void> {
		await run('readwrite', (s) => s.put(scan));
	}

	async #flushOnce(): Promise<void> {
		if (typeof indexedDB === 'undefined') return;
		const all = await this.#reload();
		let retry = false;
		for (const scan of all) {
			if (scan.error) continue;
			if (scan.organizationId !== organizations.activeId) {
				retry = true;
				continue;
			}
			this.sending = scan.id;
			try {
				if (scan.stage === 'queued') {
					const created = await organizations.call<{ document: DocumentView; upload: PresignedUpload }>(
						'POST',
						`/contracts/${scan.contractId}/uploads`,
						{ id: scan.id, kind: 'signed_scan', fileName: scan.fileName, mimeType: 'application/pdf', byteSize: scan.blob.size }
					);
					const put = await fetch(created.upload.url, {
						method: 'PUT',
						body: scan.blob,
						headers: { 'content-type': 'application/pdf' }
					});
					if (!put.ok) throw new NetworkError();
					scan.stage = 'uploaded';
					await this.#put(scan);
				}
				await organizations.call<ContractDetailView>('POST', `/contracts/${scan.contractId}/signature`, {
					documentId: scan.id,
					expectedVersion: scan.expectedVersion,
					signedOn: scan.signedOn
				});
				await run('readwrite', (s) => s.delete(scan.id));
			} catch (error) {
				if (error instanceof ApiError && error.status < 500 && error.status !== 401 && error.status !== 429) {
					await this.#put({ ...scan, error: error.message });
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

export const scanQueue = new ScanQueue();
