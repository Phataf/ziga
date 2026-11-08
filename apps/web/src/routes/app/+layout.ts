import { requireSession } from '#lib/auth/guard.ts';
import type { LayoutLoad } from './$types';

// Application de gestion : rendue côté client (local-first, D07) ; aucune page n'est générée par le serveur.
export const ssr = false;

/** Session exigée (lot 02). L'appartenance à une organisation sera vérifiée au lot 03. */
export const load: LayoutLoad = async ({ url }) => {
	await requireSession(url);
};
