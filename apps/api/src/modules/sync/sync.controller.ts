/**
 * Synchronisation hors ligne (lot 05, D30).
 * - GET /sync/credentials : adresse du service PowerSync et jeton dédié (audience ziga-sync, 5 minutes), demandé
 *   par le connecteur du client à chaque connexion. Le jeton ne porte que la personne : ce que l'appareil reçoit
 *   est décidé par les Sync Streams (infra/powersync/sync-config.yaml), à partir des appartenances actives.
 */
import { Controller, Get, Header, Inject } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module.js';
import type { AppConfig } from '../../config/env.js';
import { Auth } from '../identity/auth.guard.js';
import { AuthService } from '../identity/auth.service.js';
import { TokenService, type AccessClaims } from '../identity/token.service.js';

export interface SyncCredentials {
	endpoint: string;
	token: string;
	expiresAt: string;
}

@Controller('sync')
export class SyncController {
	constructor(
		@Inject(APP_CONFIG) private readonly config: AppConfig,
		private readonly auth: AuthService,
		private readonly tokens: TokenService
	) {}

	@Get('credentials')
	@Header('Cache-Control', 'no-store')
	async credentials(@Auth() claims: AccessClaims): Promise<SyncCredentials> {
		// Compte désactivé depuis l'émission du jeton d'accès : 401, comme pour /me.
		await this.auth.me(claims.sub);
		const { token, expiresAt } = await this.tokens.signSync(claims.sub);
		return { endpoint: this.config.POWERSYNC_URL, token, expiresAt };
	}
}
