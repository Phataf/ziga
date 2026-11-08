/**
 * Fonctionnalités ouvertes à la personne dans l'organisation active (lot 04), d'après GET /me/features.
 * L'interface masque ce qui est fermé ; le serveur le refuse quand même (CLAUDE.md §8). Copie gardée sur l'appareil
 * pour la coque hors connexion (la synchronisation par PowerSync arrive au lot 05).
 */
import type { FeatureStatusView } from '@ziga/shared/features';
import { auth } from '../auth/auth.svelte';
import { NetworkError } from '../auth/http';

const KEY = 'ziga:fonctionnalites';

type Map = Record<string, FeatureStatusView>;

function storage(): Storage | undefined {
	try {
		return typeof localStorage === 'undefined' ? undefined : localStorage;
	} catch {
		return undefined;
	}
}

class Features {
	/** null : pas encore chargées (rien n'est masqué tant qu'on ne sait pas : le serveur décide). */
	map = $state<Map | null>(null);
	organizationId = $state<string | null>(null);

	constructor() {
		auth.onSignOut(() => {
			this.map = null;
			try {
				storage()?.removeItem(KEY);
			} catch {
				// rien
			}
		});
	}

	isEnabled(key: string): boolean {
		return this.map?.[key]?.enabled ?? false;
	}

	status(key: string): FeatureStatusView | undefined {
		return this.map?.[key];
	}

	/** Pour les tests de composant et l'aperçu : état fixé à la main. */
	set(map: Map | null, organizationId: string | null = null): void {
		this.map = map;
		this.organizationId = organizationId;
	}

	async load(organizationId: string | null): Promise<void> {
		const cacheKey = `${auth.user?.id ?? ''}:${organizationId ?? ''}`;
		try {
			const r = await auth.request<{ organizationId: string | null; features: Map }>('GET', '/me/features', undefined, {
				organization: organizationId
			});
			this.set(r.features, r.organizationId);
			try {
				storage()?.setItem(KEY, JSON.stringify({ key: cacheKey, features: r.features }));
			} catch {
				// stockage refusé
			}
		} catch (error) {
			if (!(error instanceof NetworkError)) throw error;
			try {
				const saved = JSON.parse(storage()?.getItem(KEY) ?? 'null') as { key: string; features: Map } | null;
				if (saved?.key === cacheKey) this.set(saved.features, organizationId);
			} catch {
				// copie illisible : rien n'est affiché comme ouvert
			}
		}
	}
}

export const features = new Features();
