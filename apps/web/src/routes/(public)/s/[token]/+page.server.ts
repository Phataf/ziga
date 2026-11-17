import { PUBLIC_API_URL } from '$app/env/public';
import type { SharedStatementView } from '@ziga/shared/statements';
import type { PageServerLoad } from './$types';

/**
 * Relevé partagé `/s/<jeton>` (lot 10) : page légère, rendue par le serveur, sans JavaScript (le propriétaire l'ouvre
 * depuis WhatsApp, souvent en 3G). Le serveur lit l'API en transmettant l'adresse du visiteur, pour que la limite de
 * débit compte le visiteur et non le serveur web. Jamais indexée, jamais mise en cache, sans adresse de provenance.
 */
export const csr = false;

export type SharedStatementPage =
	{ state: 'ok'; view: SharedStatementView } | { state: 'missing' } | { state: 'tooMany' } | { state: 'error' };

export const load: PageServerLoad = async ({ params, fetch, getClientAddress, setHeaders }): Promise<SharedStatementPage> => {
	setHeaders({ 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
	try {
		const res = await fetch(`${PUBLIC_API_URL}/public/statements/shared/${encodeURIComponent(params.token)}`, {
			headers: { accept: 'application/json', 'x-forwarded-for': getClientAddress() }
		});
		if (res.ok) return { state: 'ok', view: (await res.json()) as SharedStatementView };
		if (res.status === 404 || res.status === 400) return { state: 'missing' };
		if (res.status === 429) return { state: 'tooMany' };
		return { state: 'error' };
	} catch {
		return { state: 'error' };
	}
};
