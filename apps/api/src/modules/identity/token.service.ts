/** Jetons d'accès : JWT signés en EdDSA, 15 minutes, avec l'identifiant de la clé (`kid`) dans l'en-tête. */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { PlatformRole } from '@ziga/shared/auth';
import { jwtVerify, SignJWT, type JWTPayload } from 'jose';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG } from '../../config/config.module.js';
import type { AppConfig } from '../../config/env.js';
import { generateKey, parseKeys, type KeyRing } from './keys.js';

export const AUDIENCE = 'ziga';

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
			this.ring = generateKey('dev-ephemere').ring;
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
