/**
 * Gardes des espaces connectés (/app, /espace, /admin), appelées par les `load` des layouts (rendu côté client).
 * Elles reflètent les droits ; l'API les vérifie toujours elle-même (CLAUDE.md §6).
 */
import { error, redirect } from '@sveltejs/kit';
import { fr } from '../i18n/fr';
import { auth } from './auth.svelte';

/** Renvoie vers /connexion seulement si le serveur a refusé la session (401) ou s'il n'y a personne à afficher. */
export async function requireSession(url: URL): Promise<void> {
	if ((await auth.ensure()) === 'signed_out') {
		redirect(307, `/connexion?retour=${encodeURIComponent(url.pathname + url.search)}`);
	}
}

/** Back-office : réservé aux rôles plateforme. */
export async function requirePlatformRole(url: URL): Promise<void> {
	await requireSession(url);
	if (!auth.isPlatformStaff) error(403, fr.auth.adminOnly);
}
