import { PUBLIC_API_URL } from '$app/env/public';
import type { RequestHandler } from './$types';

/**
 * PDF du relevé partagé, sans JavaScript : le serveur demande à l'API une adresse signée de courte durée (adresse du
 * visiteur transmise pour la limite de débit) et y redirige. Lien expiré ou PDF pas encore prêt : retour à la page.
 */
export const GET: RequestHandler = async ({ params, fetch, getClientAddress }) => {
	const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow' };
	try {
		const res = await fetch(`${PUBLIC_API_URL}/public/statements/shared/${encodeURIComponent(params.token)}/pdf`, {
			headers: { accept: 'application/json', 'x-forwarded-for': getClientAddress() }
		});
		if (res.ok) {
			const { url } = (await res.json()) as { url: string };
			return new Response(null, { status: 303, headers: { ...headers, location: url } });
		}
	} catch {
		// Retour à la page, qui dit ce qui se passe.
	}
	return new Response(null, { status: 303, headers: { ...headers, location: `/s/${encodeURIComponent(params.token)}?pdf=indisponible` } });
};
