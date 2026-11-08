import { requireSession } from '#lib/auth/guard.ts';
import type { LayoutLoad } from './$types';

// Espaces personnels : rendus côté client, comme l'application.
export const ssr = false;

/** Toute personne connectée a un espace personnel, même sans organisation (lot 02). */
export const load: LayoutLoad = async ({ url }) => {
	await requireSession(url);
};
