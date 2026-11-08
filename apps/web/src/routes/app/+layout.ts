import { requireOrganization } from '#lib/auth/guard.ts';
import type { LayoutLoad } from './$types';

// Application de gestion : rendue côté client (local-first, D07) ; aucune page n'est générée par le serveur.
export const ssr = false;

/** Session et organisation active exigées (lot 03) ; le profil vient du rôle dans cette organisation. */
export const load: LayoutLoad = async ({ url }) => {
	await requireOrganization(url);
};
