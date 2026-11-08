import { error } from '@sveltejs/kit';
import { fr } from './i18n/fr';
import { knownPaths, normalizePath } from './profiles';

/** Un chemin absent de toutes les navigations répond 404 (pas d'écran fantôme). */
export function assertKnownPath(url: URL): void {
	if (!knownPaths.has(normalizePath(url.pathname))) error(404, fr.app.notFound);
}
