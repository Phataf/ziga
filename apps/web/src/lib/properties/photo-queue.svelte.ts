/**
 * File d'envoi des photos (lot 07) : une photo prise hors ligne est gardée sur l'appareil (IndexedDB) et affichée en
 * attendant ; sa fiche (`media`, en attente) part par la synchronisation. À la reconnexion, le fichier part par l'URL
 * présignée : demande de l'URL, envoi direct au stockage, signal à l'API, puis la photo quitte la file.
 *
 * Une photo dont la fiche n'est pas encore arrivée au serveur (introuvable) attend le passage suivant ; une photo déjà
 * envoyée (ou retirée) quitte la file. La file est vidée à la déconnexion, avec la base locale.
 */
import { ApiError, NetworkError } from '../auth/http';
import { organizations } from '../org/organizations.svelte';

const DB_NAME = 'ziga-photos';
const STORE = 'queue';
const RETRY_MS = 10_000;

export interface QueuedPhoto {
	/** Identifiant de la photo (fiche `media`). */
	id: string;
	organizationId: string;
	blob: Blob;
	createdAt: number;
}

interface PresignedUpload {
	url: string;
	method: 'PUT';
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

class PhotoQueue {
	/** Aperçus locaux (adresses d'objets) des photos en file, par identifiant. */
	previews = $state<Record<string, string>>({});
	/** État d'envoi de chaque photo en file. */
	states = $state<Record<string, 'queued' | 'sending'>>({});
	count = $state(0);
	#flushing: Promise<void> | null = null;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#listening = false;

	/** Charge la file de l'appareil (aperçus compris) et écoute le retour de la connexion. */
	async start(): Promise<void> {
		if (typeof indexedDB === 'undefined') return;
		if (!this.#listening && typeof window !== 'undefined') {
			this.#listening = true;
			window.addEventListener('online', () => void this.flush());
		}
		const all = await run('readonly', (s) => s.getAll() as IDBRequest<QueuedPhoto[]>);
		for (const p of all) this.#show(p);
		this.count = all.length;
		void this.flush();
	}

	#show(p: QueuedPhoto): void {
		if (!this.previews[p.id]) this.previews = { ...this.previews, [p.id]: URL.createObjectURL(p.blob) };
		this.states = { ...this.states, [p.id]: this.states[p.id] ?? 'queued' };
	}

	#forget(id: string): void {
		const url = this.previews[id];
		if (url) URL.revokeObjectURL(url);
		const { [id]: _p, ...previews } = this.previews;
		const { [id]: _s, ...states } = this.states;
		this.previews = previews;
		this.states = states;
	}

	/** Photo prise : gardée sur l'appareil, affichée, puis envoyée dès que possible. */
	async add(photo: QueuedPhoto): Promise<void> {
		await run('readwrite', (s) => s.put(photo));
		this.#show(photo);
		this.count += 1;
		void this.flush();
	}

	/** Envoie les photos en file, une à une ; s'arrête hors connexion et réessaie plus tard. */
	flush(): Promise<void> {
		this.#flushing ??= this.#flushOnce().finally(() => (this.#flushing = null));
		return this.#flushing;
	}

	async #flushOnce(): Promise<void> {
		if (typeof indexedDB === 'undefined') return;
		const all = await run('readonly', (s) => s.getAll() as IDBRequest<QueuedPhoto[]>);
		this.count = all.length;
		let retry = false;
		for (const p of all.sort((a, b) => a.createdAt - b.createdAt)) {
			if (p.organizationId !== organizations.activeId) {
				retry = true;
				continue;
			}
			this.states = { ...this.states, [p.id]: 'sending' };
			try {
				const upload = await organizations.call<PresignedUpload>('POST', `/media/${p.id}/upload-url`);
				const res = await fetch(upload.url, { method: 'PUT', body: p.blob, headers: { 'content-type': upload.headers['content-type']! } });
				if (!res.ok) throw new Error(`PUT ${res.status}`);
				await organizations.call('POST', `/media/${p.id}/uploaded`);
				await this.#drop(p.id);
			} catch (error) {
				this.states = { ...this.states, [p.id]: 'queued' };
				// Déjà envoyée ou retirée : elle quitte la file. Fiche pas encore synchronisée, ou hors ligne : plus tard.
				if (error instanceof ApiError && error.code === 'MEDIA_NOT_PENDING') {
					await this.#drop(p.id);
					continue;
				}
				retry = true;
				if (error instanceof NetworkError) break;
			}
		}
		if (retry && this.count > 0) this.#schedule();
	}

	async #drop(id: string): Promise<void> {
		await run('readwrite', (s) => s.delete(id));
		this.#forget(id);
		this.count = Math.max(0, this.count - 1);
	}

	#schedule(): void {
		if (this.#timer) return;
		this.#timer = setTimeout(() => {
			this.#timer = null;
			void this.flush();
		}, RETRY_MS);
	}

	/** Déconnexion : la file et ses aperçus sont effacés de l'appareil. */
	async clear(): Promise<void> {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
		for (const id of Object.keys(this.previews)) this.#forget(id);
		this.count = 0;
		if (typeof indexedDB === 'undefined') return;
		await run('readwrite', (s) => s.clear()).catch(() => undefined);
	}
}

export const photoQueue = new PhotoQueue();
