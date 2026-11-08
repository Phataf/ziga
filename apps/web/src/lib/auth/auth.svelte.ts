/**
 * Session de la personne connectée, côté navigateur (lot 02).
 * - Le jeton d'accès (15 min) vit en mémoire seulement ; le jeton de rafraîchissement est un cookie httpOnly de l'API.
 * - Les rafraîchissements sont sérialisés entre onglets (Web Locks) : deux onglets n'envoient jamais le même cookie
 *   en même temps. Un 409 (rotation simultanée) est réessayé une seule fois.
 * - Hors connexion, la coque reste affichée grâce au repère non secret (marker.ts) ; seul un 401 renvoie vers /connexion.
 */
import type { MeResponse, PlatformRole, SessionView, TokenResponse } from '@ziga/shared/auth';
import { ApiError, call, NetworkError, type Method } from './http';
import { clearMarker, MARKER_KEY, readMarker, writeMarker } from './marker';
import { refreshFailure } from './outcome';

export type AuthStatus = 'unknown' | 'signed_in' | 'offline' | 'signed_out';

/** Personne affichée par la coque : complète en ligne, réduite au repère hors connexion. */
export interface CurrentUser {
	id: string;
	name: string;
	phone?: string;
	platformRole: PlatformRole | null;
}

const LOCK = 'ziga-auth-refresh';
/** Marge avant l'expiration du jeton d'accès : on le renouvelle une minute avant. */
const EARLY_MS = 60_000;

const storage = (): Storage | undefined => {
	try {
		return typeof localStorage === 'undefined' ? undefined : localStorage;
	} catch {
		return undefined;
	}
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Auth {
	status = $state<AuthStatus>('unknown');
	user = $state<CurrentUser | null>(null);

	#token: string | null = null;
	#expiresAt = 0;
	#pending: Promise<AuthStatus> | null = null;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#listening = false;
	#onSignOut: (() => void)[] = [];

	/** Appelé à chaque déconnexion locale (ex. oubli des organisations gardées sur l'appareil). */
	onSignOut(fn: () => void): void {
		this.#onSignOut.push(fn);
	}

	get isPlatformStaff(): boolean {
		return !!this.user?.platformRole;
	}

	/** Session utilisable ? Rafraîchit si le jeton d'accès manque ou expire bientôt. */
	async ensure(): Promise<AuthStatus> {
		this.#listen();
		if (this.#token && this.#expiresAt - Date.now() > EARLY_MS) return 'signed_in';
		return this.refresh();
	}

	/** Un seul rafraîchissement à la fois dans l'onglet, et entre onglets par Web Locks quand ils existent. */
	refresh(): Promise<AuthStatus> {
		this.#pending ??= (async () => {
			try {
				const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
				return locks ? await locks.request(LOCK, () => this.#refreshOnce()) : await this.#refreshOnce();
			} finally {
				this.#pending = null;
			}
		})();
		return this.#pending;
	}

	async #refreshOnce(attempt = 0): Promise<AuthStatus> {
		try {
			this.#accept(await call<TokenResponse>('POST', '/auth/refresh'));
			return 'signed_in';
		} catch (error) {
			if (error instanceof ApiError && error.status === 409 && attempt === 0) {
				// Deux rafraîchissements simultanés (navigateur sans Web Locks) : un seul nouvel essai, jamais de boucle.
				// Une réponse perdue n'aboutit plus à un 409 : le serveur réémet un jeton dans le délai de grâce (D28).
				await wait(300);
				return this.#refreshOnce(1);
			}
			if (!(error instanceof ApiError) && !(error instanceof NetworkError)) throw error;
			// Coupure passagère (réseau tout juste revenu, changement d'antenne) : un nouvel essai si le navigateur se dit en ligne.
			if (error instanceof NetworkError && attempt < 1 && typeof navigator !== 'undefined' && navigator.onLine) {
				await wait(500);
				return this.#refreshOnce(attempt + 1);
			}
			const marker = readMarker(storage());
			if (refreshFailure(error instanceof ApiError ? error : null, !!marker) === 'signed_out') {
				this.#signOutLocally();
				return 'signed_out';
			}
			// Hors connexion : on garde la personne du repère, sans jeton d'accès.
			this.#token = null;
			this.user = { id: marker!.userId, name: marker!.name, platformRole: marker!.platformRole };
			this.status = 'offline';
			return 'offline';
		}
	}

	/** Session ouverte par la connexion, la vérification du numéro, la réinitialisation ou un rafraîchissement. */
	#accept(response: TokenResponse): void {
		this.#token = response.accessToken;
		this.#expiresAt = Date.now() + response.expiresIn * 1000;
		this.user = { ...response.user };
		this.status = 'signed_in';
		writeMarker(storage(), response.user);
		clearTimeout(this.#timer);
		if (typeof window !== 'undefined') {
			this.#timer = setTimeout(() => void this.refresh(), Math.max(5_000, response.expiresIn * 1000 - EARLY_MS));
		}
	}

	#signOutLocally(): void {
		this.#token = null;
		this.#expiresAt = 0;
		clearTimeout(this.#timer);
		clearMarker(storage());
		for (const fn of this.#onSignOut) fn();
		this.user = null;
		this.status = 'signed_out';
	}

	#listen(): void {
		if (this.#listening || typeof window === 'undefined') return;
		this.#listening = true;
		// Retour du réseau : on renouvelle la session restée affichée hors connexion.
		window.addEventListener('online', () => {
			if (this.status === 'offline') void this.refresh();
		});
		// Déconnexion dans un autre onglet : le repère disparaît, cet onglet se déconnecte aussi.
		window.addEventListener('storage', (event) => {
			if (event.key === MARKER_KEY && event.newValue === null && this.status !== 'signed_out') {
				this.#signOutLocally();
				location.assign('/connexion');
			}
		});
	}

	/** Appel authentifié ; un 401 renouvelle le jeton une fois puis réessaie. */
	async request<T>(method: Method, path: string, body?: unknown, options: { organization?: string | null; file?: Blob } = {}): Promise<T> {
		const status = await this.ensure();
		if (status === 'offline') throw new NetworkError();
		if (status === 'signed_out') throw new ApiError(401, 'SESSION_INVALID', 'Session expirée. Reconnectez-vous.');
		try {
			return await call<T>(method, path, { body, token: this.#token, ...options });
		} catch (error) {
			if (!(error instanceof ApiError) || error.status !== 401) throw error;
			this.#token = null;
			if ((await this.refresh()) !== 'signed_in') throw error;
			return call<T>(method, path, { body, token: this.#token, ...options });
		}
	}

	/** Met à jour la personne affichée (Mon compte) et son repère. */
	setUser(user: MeResponse): void {
		this.user = { ...user };
		writeMarker(storage(), user);
	}

	async register(input: { phone: string; name: string; password: string }): Promise<void> {
		await call('POST', '/auth/register', { body: input });
	}

	async verifyPhone(input: { phone: string; code: string }): Promise<void> {
		this.#accept(await call<TokenResponse>('POST', '/auth/verify-phone', { body: input }));
	}

	async login(input: { phone: string; password: string }): Promise<void> {
		this.#accept(await call<TokenResponse>('POST', '/auth/login', { body: input }));
	}

	async forgotPassword(input: { phone: string }): Promise<void> {
		await call('POST', '/auth/password/forgot', { body: input });
	}

	async resetPassword(input: { phone: string; code: string; password: string }): Promise<void> {
		this.#accept(await call<TokenResponse>('POST', '/auth/password/reset', { body: input }));
	}

	/** Déconnexion : il faut joindre le serveur, sinon la session resterait ouverte sur ce navigateur. */
	async logout(): Promise<void> {
		await call('POST', '/auth/logout');
		this.#signOutLocally();
	}

	me(): Promise<MeResponse> {
		return this.request<MeResponse>('GET', '/me');
	}

	sessions(): Promise<SessionView[]> {
		return this.request<SessionView[]>('GET', '/sessions');
	}

	revokeSession(id: string): Promise<void> {
		return this.request<void>('DELETE', `/sessions/${encodeURIComponent(id)}`);
	}
}

export const auth = new Auth();
