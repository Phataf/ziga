/**
 * Que faire quand un rafraîchissement échoue (lot 02, correction b) : seul un refus explicite du serveur (401)
 * déconnecte. Une absence de réseau, un serveur en panne (5xx) ou une limite de débit (429) laissent la coque
 * affichée si un repère valide existe ; sans repère, il n'y a personne à afficher.
 */
export type RefreshOutcome = 'signed_out' | 'offline';

export function refreshFailure(error: { status?: number } | null | undefined, hasMarker: boolean): RefreshOutcome {
	if (error?.status === 401) return 'signed_out';
	return hasMarker ? 'offline' : 'signed_out';
}

/** Chemin de retour accepté après connexion : interne à l'application uniquement (pas de redirection ouverte). */
export function safeReturn(value: string | null | undefined, fallback = '/espace'): string {
	if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
	if (!/^\/(app|espace|admin)(\/|\?|$)/.test(value)) return fallback;
	return value;
}
