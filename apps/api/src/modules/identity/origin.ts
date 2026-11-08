/**
 * Routes qui lisent le cookie de rafraîchissement : l'origine doit être l'une des origines autorisées (CORS_ORIGINS)
 * et la requête doit être du JSON (ce qui impose une vérification préalable CORS au navigateur).
 * Parade contre une requête forgée depuis un autre site, même du même domaine (préproduction, D28).
 */
import type { Request } from 'express';
import { AppError } from '../../common/app-error.js';

export function assertTrustedOrigin(request: Request, allowed: string[]): void {
	const origin = request.headers.origin;
	const json = (request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json');
	if (!origin || !allowed.includes(origin) || !json) {
		throw new AppError('FORBIDDEN_ORIGIN', 'Origine non autorisée.', 403);
	}
}
