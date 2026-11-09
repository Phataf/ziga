/**
 * Fonctionnalités ouvertes à la personne dans l'organisation active.
 * - Lot 05 : calculées sur l'appareil, à partir de la base locale synchronisée, avec la même fonction pure que le
 *   serveur (resolveAll) : lisibles hors connexion, et une exception échue cesse de compter à l'heure de l'appareil.
 * - Avant la première synchronisation, et dans l'espace personnel : GET /me/features (lot 04), avec une copie gardée
 *   sur l'appareil.
 * L'interface masque ce qui est fermé ; le serveur le refuse quand même (CLAUDE.md §8).
 */
import { FEATURES_BY_KEY, resolveAll, toStatusView, type FeatureStatusView } from '@ziga/shared/features';
import { auth } from '../auth/auth.svelte';
import { NetworkError } from '../auth/http';
import { LOCAL_QUERIES } from '../sync/queries';
import { sync } from '../sync/sync.svelte';
import { disabledKeys, toResolutionData } from '../sync/views';

const KEY = 'ziga:fonctionnalites';

type Map = Record<string, FeatureStatusView>;

/** Ligne du réglage des fonctionnalités par le directeur (même forme que GET /organization/features). */
export interface OrganizationFeatureRow extends FeatureStatusView {
	key: string;
	label: string;
	openByPlatform: boolean;
	disabledByOrganization: boolean;
}

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
	/** Réglages de l'organisation calculés sur l'appareil (lot 05) ; null tant que la base locale n'a rien reçu. */
	organizationRows = $state<OrganizationFeatureRow[] | null>(null);

	#stopLocal: (() => void)[] = [];

	constructor() {
		auth.onSignOut(() => {
			this.stopLocal();
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

	/**
	 * Suit la base locale pour cette organisation : l'état est recalculé à chaque changement synchronisé, et chaque
	 * minute (fin d'une exception). Tant que la base n'a rien reçu, l'état venu de l'API reste affiché.
	 */
	followLocal(organizationId: string): void {
		this.stopLocal();
		const userId = auth.user?.id ?? null;
		type Rows = Record<string, unknown>[];
		const parts: { features?: Rows; plans?: Rows; overrides?: Rows; settings?: Rows; org?: Rows } = {};
		const recompute = () => {
			const { features, plans, overrides, settings, org } = parts;
			if (!features?.length || !plans || !overrides || !settings || !org?.length) return;
			const data = toResolutionData(features, plans, overrides);
			const planId = String(org[0]!.plan_id);
			const disabled = disabledKeys(settings);
			const now = new Date();
			const all = resolveAll({ organizationId, userId, planId, disabledByOrganization: disabled, now }, data);
			// Ce que la plateforme ouvre à l'organisation, sans ses propres désactivations (comme le serveur).
			const open = resolveAll({ organizationId, userId: null, planId, disabledByOrganization: [], now }, data);
			const map = Object.fromEntries(Object.entries(all).map(([k, r]) => [k, toStatusView(r)]));
			this.organizationRows = Object.keys(all).map((key) => ({
				key,
				label: FEATURES_BY_KEY[key as keyof typeof FEATURES_BY_KEY]?.label ?? key,
				...map[key]!,
				openByPlatform: open[key]!.enabled,
				disabledByOrganization: disabled.includes(key)
			}));
			this.set(map, organizationId);
			this.#save(`${userId ?? ''}:${organizationId}`, map);
		};
		const follow = (sql: string, params: unknown[], key: keyof typeof parts) =>
			sync.watch<Record<string, unknown>>(sql, params, (rows) => {
				parts[key] = rows;
				recompute();
			});
		this.#stopLocal.push(
			follow(LOCAL_QUERIES.features, [], 'features'),
			follow(LOCAL_QUERIES.planFeatures, [], 'plans'),
			follow(LOCAL_QUERIES.featureOverrides, [organizationId, userId], 'overrides'),
			follow(LOCAL_QUERIES.featureSettings, [organizationId], 'settings'),
			follow(LOCAL_QUERIES.organization, [organizationId], 'org')
		);
		const timer = setInterval(recompute, 60_000);
		this.#stopLocal.push(() => clearInterval(timer));
	}

	stopLocal(): void {
		for (const stop of this.#stopLocal.splice(0)) stop();
		this.organizationRows = null;
	}

	#save(key: string, features: Map): void {
		try {
			storage()?.setItem(KEY, JSON.stringify({ key, features }));
		} catch {
			// stockage refusé
		}
	}

	async load(organizationId: string | null): Promise<void> {
		const cacheKey = `${auth.user?.id ?? ''}:${organizationId ?? ''}`;
		try {
			const r = await auth.request<{ organizationId: string | null; features: Map }>('GET', '/me/features', undefined, {
				organization: organizationId
			});
			// La base locale a déjà répondu pour cette organisation : elle l'emporte (même calcul, données plus fraîches).
			if (this.organizationRows && this.organizationId === r.organizationId) return;
			this.set(r.features, r.organizationId);
			this.#save(cacheKey, r.features);
		} catch (error) {
			if (!(error instanceof NetworkError)) throw error;
			if (this.organizationRows) return;
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
