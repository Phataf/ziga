import { requirePlatformRole } from '#lib/auth/guard.ts';
import type { LayoutLoad } from './$types';

// Back-office : rendu côté client, pensé pour l'ordinateur (docs/UX.md §2).
export const ssr = false;

/** Réservé aux rôles plateforme (super_admin, support, sales, finance) ; l'API le vérifie aussi. */
export const load: LayoutLoad = async ({ url }) => {
	await requirePlatformRole(url);
};
