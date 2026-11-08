/** Règles de la session côté navigateur (lot 02, correction b) : repère de 30 jours glissants, seul un 401 déconnecte. */
import { describe, expect, it } from 'vitest';
import { clearMarker, MARKER_KEY, MARKER_TTL_MS, readMarker, writeMarker } from './marker';
import { refreshFailure, safeReturn } from './outcome';

function memoryStore() {
	const map = new Map<string, string>();
	return {
		map,
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k)
	};
}

const user = { id: '0190f0e2-0000-7000-8000-000000000001', name: 'Awa Ouédraogo', phone: '+22670123456', platformRole: null };
const day = 24 * 60 * 60 * 1000;

describe('repère de la dernière session', () => {
	it('ne contient aucun secret : ni téléphone, ni jeton', () => {
		const store = memoryStore();
		writeMarker(store, user, 1_000);
		const raw = store.map.get(MARKER_KEY)!;
		expect(JSON.parse(raw)).toEqual({ userId: user.id, name: user.name, platformRole: null, refreshedAt: 1_000 });
		expect(raw).not.toContain('+226');
	});

	it('est valable 30 jours après le dernier rafraîchissement, puis effacé', () => {
		const store = memoryStore();
		const t0 = Date.UTC(2026, 10, 1);
		writeMarker(store, user, t0);
		expect(readMarker(store, t0 + 29 * day)?.userId).toBe(user.id);
		expect(readMarker(store, t0 + MARKER_TTL_MS)).toBeNull();
		expect(store.map.has(MARKER_KEY)).toBe(false);
	});

	it('30 jours glissants : chaque rafraîchissement repousse l’échéance', () => {
		const store = memoryStore();
		const t0 = Date.UTC(2026, 10, 1);
		writeMarker(store, user, t0);
		writeMarker(store, user, t0 + 20 * day);
		expect(readMarker(store, t0 + 45 * day)?.name).toBe(user.name);
	});

	it('un repère illisible, daté du futur ou effacé ne vaut rien', () => {
		const store = memoryStore();
		store.setItem(MARKER_KEY, '{pas du json');
		expect(readMarker(store, 0)).toBeNull();
		store.setItem(MARKER_KEY, JSON.stringify({ userId: 1 }));
		expect(readMarker(store, 0)).toBeNull();
		writeMarker(store, user, 10_000);
		expect(readMarker(store, 5_000)).toBeNull();
		writeMarker(store, user, 1_000);
		clearMarker(store);
		expect(readMarker(store, 2_000)).toBeNull();
		expect(readMarker(undefined)).toBeNull();
	});
});

describe('échec du rafraîchissement', () => {
	it('seul un refus explicite du serveur (401) déconnecte', () => {
		expect(refreshFailure({ status: 401 }, true)).toBe('signed_out');
	});

	it('pas de réseau, serveur en panne ou limite de débit : la coque reste, avec le repère', () => {
		for (const error of [null, { status: 500 }, { status: 502 }, { status: 503 }, { status: 429 }]) {
			expect(refreshFailure(error, true)).toBe('offline');
		}
	});

	it('sans repère, personne à afficher : écran de connexion', () => {
		expect(refreshFailure(null, false)).toBe('signed_out');
	});
});

describe('retour après connexion', () => {
	it('accepte seulement un chemin interne des espaces connectés', () => {
		expect(safeReturn('/app/biens?tri=nom')).toBe('/app/biens?tri=nom');
		expect(safeReturn('/invitation/abc.def')).toBe('/invitation/abc.def');
		expect(safeReturn('/espace/appareils')).toBe('/espace/appareils');
		expect(safeReturn('/admin')).toBe('/admin');
		for (const bad of ['https://exemple.com', '//exemple.com', '/\\exemple.com', '/connexion', '/application', '', null]) {
			expect(safeReturn(bad)).toBe('/espace');
		}
	});
});
