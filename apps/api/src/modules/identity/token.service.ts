/** Jetons d'accès : JWT signés en EdDSA, 15 minutes, avec l'identifiant de la clé (`kid`) dans l'en-tête. */
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { PlatformRole } from '@ziga/shared/auth';
import { jwtVerify, SignJWT, type JWTPayload } from 'jose';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG } from '../../config/config.module.js';
import type { AppConfig } from '../../config/env.js';
import { generateKey, parseKeys, type KeyRing } from './keys.js';

export const AUDIENCE = 'ziga';
/**
 * Audience du jeton de synchronisation (lot 05, D30) : seul PowerSync l'accepte, jamais l'API (vérification de
 * l'audience ci-dessous). Même clé et même JWKS que les jetons d'accès, sans secret partagé.
 */
export const SYNC_AUDIENCE = 'ziga-sync';

export interface AccessClaims {
	/** Personne. */
	sub: string;
	/** Session (appareil). */
	sid: string;
	/** Rôle plateforme, ou null. Aucune organisation ici : elles arrivent au lot 03. */
	prole: PlatformRole | null;
}

@Injectable()
export class TokenService implements OnModuleInit {
	ring!: KeyRing;

	constructor(
		@Inject(APP_CONFIG) private readonly config: AppConfig,
		private readonly logger: PinoLogger
	) {
		logger.setContext(TokenService.name);
	}

	onModuleInit(): void {
		if (this.config.AUTH_JWT_KEYS) {
			this.ring = parseKeys(this.config.AUTH_JWT_KEYS);
		} else {
			// Identifiant propre à chaque démarrage : PowerSync relit le JWKS dès qu'il voit un `kid` inconnu, alors qu'une
			// nouvelle clé sous un `kid` déjà connu serait refusée jusqu'à son prochain rafraîchissement (5 minutes).
			this.ring = generateKey(`dev-${randomUUID().slice(0, 8)}`).ring;
			this.logger.warn('AUTH_JWT_KEYS absente : clé de signature éphémère (développement et tests seulement)');
		}
	}

	get ttlSeconds(): number {
		return this.config.AUTH_ACCESS_TTL_SECONDS;
	}

	async sign(claims: AccessClaims): Promise<string> {
		const key = this.ring.current;
		return new SignJWT({ sid: claims.sid, prole: claims.prole })
			.setProtectedHeader({ alg: 'EdDSA', kid: key.kid, typ: 'JWT' })
			.setSubject(claims.sub)
			.setIssuer(this.config.API_PUBLIC_URL)
			.setAudience(AUDIENCE)
			.setIssuedAt()
			.setExpirationTime(`${this.ttlSeconds}s`)
			.sign(key.privateKey);
	}

	/**
	 * Jeton de synchronisation : la personne seulement (`sub`), aucune organisation. Le stream de PowerSync lit les
	 * appartenances en direct, si bien qu'un membre retiré perd l'accès à la synchronisation suivante, sans attendre
	 * l'expiration du jeton.
	 */
	async signSync(userId: string): Promise<{ token: string; expiresAt: string }> {
		const key = this.ring.current;
		const ttl = this.config.SYNC_TOKEN_TTL_SECONDS;
		const now = Math.floor(Date.now() / 1000);
		const token = await new SignJWT({})
			.setProtectedHeader({ alg: 'EdDSA', kid: key.kid, typ: 'JWT' })
			.setSubject(userId)
			.setIssuer(this.config.API_PUBLIC_URL)
			.setAudience(SYNC_AUDIENCE)
			.setIssuedAt(now)
			.setExpirationTime(now + ttl)
			.sign(key.privateKey);
		return { token, expiresAt: new Date((now + ttl) * 1000).toISOString() };
	}

	/** Vérifie signature, émetteur, audience et expiration ; renvoie null si le jeton n'est pas valable. */
	async verify(token: string): Promise<AccessClaims | null> {
		try {
			const { payload } = await jwtVerify<JWTPayload & { sid?: string; prole?: PlatformRole | null }>(
				token,
				async (header) => {
					const key = this.ring.find(header.kid);
					if (!key) throw new Error('clé inconnue');
					return key.publicKey;
				},
				{ algorithms: ['EdDSA'], issuer: this.config.API_PUBLIC_URL, audience: AUDIENCE }
			);
			if (!payload.sub || !payload.sid) return null;
			return { sub: payload.sub, sid: payload.sid, prole: payload.prole ?? null };
		} catch {
			return null;
		}
	}
}
