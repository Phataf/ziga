import { organizations } from '#lib/org/organizations.svelte.ts';
import type { PageLoad } from './$types';

/**
 * Organisations de la personne (en ligne, sinon celles gardées sur l'appareil). SvelteKit lance les `load` du
 * layout et de la page en parallèle : on attend d'abord la session (garde du layout).
 */
export const load: PageLoad = async ({ parent }) => {
	await parent();
	await organizations.load(true);
};
