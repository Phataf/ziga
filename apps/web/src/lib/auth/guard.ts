/**
 * Gardes des espaces connectés (/app, /espace, /admin), appelées par les `load` des layouts (rendu côté client).
 * Elles reflètent les droits ; l'API les vérifie toujours elle-même (CLAUDE.md §6).
 */
import { error, redirect } from '@sveltejs/kit';
import { fr } from '../i18n/fr';
import { features } from '../features/features.svelte';
import { organizations } from '../org/organizations.svelte';
import { sync } from '../sync/sync.svelte';
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

/**
 * Espace de gestion (/app) : session et organisation active exigées. Sans organisation active (aucune, ou
 * plusieurs sans choix), la personne choisit dans /espace. Hors connexion, la liste gardée sur l'appareil sert.
 */
export async function requireOrganization(url: URL): Promise<void> {
	await requireSession(url);
	await organizations.load();
	if (!organizations.active) redirect(307, '/espace');
	// Lot 05 : base locale ouverte et synchronisée en arrière-plan ; les écrans lisent dedans, sans attendre le réseau.
	void sync.start().catch(() => undefined);
	const organizationId = organizations.active.organizationId;
	if (features.organizationId !== organizationId || !features.organizationRows) features.followLocal(organizationId);
	// Fonctionnalités : calculées sur l'appareil ; l'API ne sert qu'avant la première synchronisation, sans bloquer
	// l'ouverture de l'écran (le serveur décide de toute façon).
	if (!features.organizationRows) void features.load(organizationId).catch(() => undefined);
}
