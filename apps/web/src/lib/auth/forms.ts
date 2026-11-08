/** Outils des formulaires d'authentification : erreurs par champ et message d'une erreur d'appel. */
import { PHONE_INVALID_MESSAGE, toE164 } from '@ziga/shared/phone';
import { fr } from '../i18n/fr';
import { ApiError, NetworkError } from './http';

interface Issues {
	issues: { path: PropertyKey[]; message: string }[];
}

/** Première erreur de chaque champ, à partir des problèmes d'un schéma Zod de packages/shared. */
export function fieldErrors(error: Issues | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const issue of error?.issues ?? []) {
		const key = String(issue.path[0] ?? '');
		out[key] ??= issue.message;
	}
	return out;
}

/** Message à afficher pour une erreur d'appel : celui du serveur (en français), ou l'absence de réseau. */
export function messageOf(error: unknown): string {
	if (error instanceof NetworkError) return fr.auth.network;
	if (error instanceof ApiError) return error.message;
	return fr.auth.network;
}

/** Numéro saisi et indicatif choisi → E.164, ou l'erreur à afficher sous le champ. */
export function phoneOf(input: string, country: string): { phone: string } | { error: string } {
	const phone = toE164(input, country);
	return phone ? { phone } : { error: PHONE_INVALID_MESSAGE };
}
