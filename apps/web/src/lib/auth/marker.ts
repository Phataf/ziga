/**
 * Repère de la dernière personne connectée sur ce navigateur (lot 02, correction b).
 * Il n'est pas secret : identifiant, nom, rôle plateforme et date du dernier rafraîchissement réussi.
 * Il sert seulement à afficher la coque hors connexion ; le jeton d'accès reste en mémoire et le jeton de
 * rafraîchissement dans un cookie httpOnly. Valable 30 jours glissants : la durée repart à chaque rafraîchissement,
 * comme le cookie de rafraîchissement.
 */
import type { MeResponse, PlatformRole } from '@ziga/shared/auth';

export const MARKER_KEY = 'ziga:derniere-session';
export const MARKER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionMarker {
	userId: string;
	name: string;
	platformRole: PlatformRole | null;
	/** Instant du dernier rafraîchissement réussi (millisecondes). */
	refreshedAt: number;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function isMarker(value: unknown): value is SessionMarker {
	const v = value as SessionMarker;
	return (
		!!v &&
		typeof v.userId === 'string' &&
		typeof v.name === 'string' &&
		(v.platformRole === null || typeof v.platformRole === 'string') &&
		Number.isFinite(v.refreshedAt)
	);
}

/** Repère valide, ou `null` s'il est absent, illisible ou plus vieux que 30 jours (il est alors effacé). */
export function readMarker(store: Store | undefined, now = Date.now()): SessionMarker | null {
	if (!store) return null;
	try {
		const raw = store.getItem(MARKER_KEY);
		if (!raw) return null;
		const value: unknown = JSON.parse(raw);
		if (isMarker(value) && value.refreshedAt <= now && now - value.refreshedAt < MARKER_TTL_MS) return value;
		store.removeItem(MARKER_KEY);
		return null;
	} catch {
		return null;
	}
}

export function writeMarker(store: Store | undefined, user: MeResponse, now = Date.now()): void {
	const marker: SessionMarker = { userId: user.id, name: user.name, platformRole: user.platformRole, refreshedAt: now };
	try {
		store?.setItem(MARKER_KEY, JSON.stringify(marker));
	} catch {
		// Stockage refusé (navigation privée) : la session reste en mémoire, sans coque hors connexion.
	}
}

export function clearMarker(store: Store | undefined): void {
	try {
		store?.removeItem(MARKER_KEY);
	} catch {
		// rien à effacer
	}
}
