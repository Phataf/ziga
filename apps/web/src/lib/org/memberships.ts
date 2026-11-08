/**
 * Appartenances gardées sur l'appareil (lot 03) : la coque de l'application s'affiche hors connexion avec le rôle
 * de l'organisation active. Rien de secret : nom, type et rôle, liés à la personne du repère de session.
 * Effacées à la déconnexion.
 */
import type { MembershipView } from '@ziga/shared/organizations';

export const MEMBERSHIPS_KEY = 'ziga:organisations';

export interface StoredMemberships {
	userId: string;
	memberships: MembershipView[];
	activeId: string | null;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function readMemberships(store: Store | undefined, userId: string): StoredMemberships | null {
	try {
		const raw = store?.getItem(MEMBERSHIPS_KEY);
		if (!raw) return null;
		const value = JSON.parse(raw) as StoredMemberships;
		// Gardées pour une autre personne (appareil partagé) : ignorées.
		if (value?.userId !== userId || !Array.isArray(value.memberships)) return null;
		return value;
	} catch {
		return null;
	}
}

export function writeMemberships(store: Store | undefined, value: StoredMemberships): void {
	try {
		store?.setItem(MEMBERSHIPS_KEY, JSON.stringify(value));
	} catch {
		// stockage refusé : l'organisation active reste en mémoire
	}
}

export function clearMemberships(store: Store | undefined): void {
	try {
		store?.removeItem(MEMBERSHIPS_KEY);
	} catch {
		// rien à effacer
	}
}

/**
 * Organisation active : celle choisie si elle est encore dans la liste ; sinon la seule organisation de la personne ;
 * sinon aucune (la personne choisit dans /espace). Jamais deux à la fois.
 */
export function pickActive(memberships: MembershipView[], wanted: string | null): string | null {
	if (wanted && memberships.some((m) => m.organizationId === wanted)) return wanted;
	return memberships.length === 1 ? memberships[0]!.organizationId : null;
}
