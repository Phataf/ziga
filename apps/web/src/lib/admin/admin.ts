/** Appels du back-office (lot 04) : routes /admin de l'API, protégées côté serveur par le rôle plateforme. */
import { platformCan, type PlatformAction } from '@ziga/shared/permissions';
import { auth } from '../auth/auth.svelte';
import type { Method } from '../auth/http';

export function adminCall<T>(method: Method, path: string, body?: unknown): Promise<T> {
	return auth.request<T>(method, `/admin${path}`, body);
}

/** Le rôle de la personne permet-il l'action ? (l'interface masque ; l'API décide) */
export function allowed(action: PlatformAction): boolean {
	return platformCan(auth.user?.platformRole, action);
}

/** Date et heure à Ouagadougou. */
export function dateTime(iso: string): string {
	return new Intl.DateTimeFormat('fr-FR', {
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		timeZone: 'Africa/Ouagadougou'
	}).format(new Date(iso));
}
