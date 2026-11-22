/**
 * Lecture en ligne d'un écran d'espace personnel (lot 10 ter) : ces espaces lisent dans plusieurs organisations et ne
 * sont pas copiés sur l'appareil. État de chargement, erreur et nouvel essai ; aucune règle métier ici.
 */
import { auth } from '#lib/auth/auth.svelte.ts';
import { messageOf } from '#lib/auth/forms.ts';
import { appendPage, type HistoryItem } from './tenant.ts';

export class Remote<T> {
	data = $state<T | null>(null);
	error = $state<string | null>(null);
	loading = $state(true);

	constructor(private readonly path: string) {}

	async load(): Promise<void> {
		this.loading = true;
		this.error = null;
		try {
			this.data = await auth.request<T>('GET', this.path);
		} catch (error) {
			this.error = messageOf(error);
		} finally {
			this.loading = false;
		}
	}
}

/** Ouvre un lien signé reçu du serveur (PDF d'un relevé, d'un reçu, document) dans un nouvel onglet. */
export async function openSigned(path: string, body?: unknown): Promise<void> {
	const { url } = await auth.request<{ url: string }>('POST', path, body);
	window.open(url, '_blank', 'noopener');
}

/** Historique du locataire par pages (curseur du serveur), chaque page ajoutée aux précédentes sans doublon. */
export class HistoryPages {
	items = $state<HistoryItem[]>([]);
	next = $state<string | null>(null);
	error = $state<string | null>(null);
	loading = $state(true);
	loaded = $state(false);

	async load(more = false): Promise<void> {
		this.loading = true;
		this.error = null;
		try {
			const path = `/me/portal/tenant/history${more && this.next ? `?cursor=${encodeURIComponent(this.next)}` : ''}`;
			const page = await auth.request<{ items: HistoryItem[]; nextCursor: string | null }>('GET', path);
			this.items = appendPage(more ? this.items : [], page.items);
			this.next = page.nextCursor;
			this.loaded = true;
		} catch (error) {
			this.error = messageOf(error);
		} finally {
			this.loading = false;
		}
	}
}
