import type { PageServerLoad } from './$types';

/**
 * Page de vérification d'un reçu (QR code, lot 09) : jamais indexée, jamais mise en cache (aucun cache Cloudflare),
 * sans adresse de provenance transmise. Les données sont lues par le navigateur, pour que la limite de débit de l'API
 * compte l'adresse du visiteur.
 */
export const load: PageServerLoad = ({ setHeaders }) => {
	setHeaders({ 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
};
