/**
 * Appels à l'API. Les erreurs sont de deux sortes, à ne jamais confondre (correction b du lot 02) :
 * - `ApiError` : le serveur a répondu et refuse (401, 403, 429…) ;
 * - `NetworkError` : pas de réponse (hors connexion, serveur injoignable).
 */
import { PUBLIC_API_URL } from '$app/env/public';

export class ApiError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message: string,
		public readonly retryAfter?: number,
		public readonly details?: unknown
	) {
		super(message);
		this.name = 'ApiError';
	}
}

export class NetworkError extends Error {
	constructor() {
		super('Serveur injoignable.');
		this.name = 'NetworkError';
	}
}

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface CallOptions {
	body?: unknown;
	/** Corps binaire (logo) envoyé tel quel, avec son type. */
	file?: Blob;
	token?: string | null;
	/** Organisation active (en-tête X-Organization-Id), pour les routes de gestion. */
	organization?: string | null;
	signal?: AbortSignal;
}

export async function call<T>(method: Method, path: string, options: CallOptions = {}): Promise<T> {
	const headers: Record<string, string> = { Accept: 'application/json' };
	// Toujours un corps JSON pour les écritures : l'API l'exige sur /auth/refresh et /auth/logout (protection CSRF).
	let body: BodyInit | undefined;
	if (options.file) {
		body = options.file;
		headers['Content-Type'] = options.file.type;
	} else if (method !== 'GET') {
		body = JSON.stringify(options.body ?? {});
		headers['Content-Type'] = 'application/json';
	}
	if (options.token) headers.Authorization = `Bearer ${options.token}`;
	if (options.organization) headers['X-Organization-Id'] = options.organization;
	let response: Response;
	try {
		response = await fetch(`${PUBLIC_API_URL}${path}`, {
			method,
			headers,
			body,
			// Le cookie de rafraîchissement (httpOnly) n'est envoyé qu'à l'API, sous le même site (D28).
			credentials: 'include',
			cache: 'no-store',
			signal: options.signal
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === 'AbortError') throw error;
		throw new NetworkError();
	}
	if (response.status === 204) return undefined as T;
	const data: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		const err = (data ?? {}) as { code?: string; message?: string; details?: unknown };
		const retry = Number(response.headers.get('Retry-After'));
		throw new ApiError(
			response.status,
			err.code ?? `HTTP_${response.status}`,
			err.message ?? 'Une erreur est survenue.',
			Number.isFinite(retry) && retry > 0 ? retry : undefined,
			err.details
		);
	}
	return data as T;
}
