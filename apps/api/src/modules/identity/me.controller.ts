/** Routes de la personne connectée : protégées par le garde global. */
import { Controller, Delete, Get, HttpCode, Param } from '@nestjs/common';
import { idSchema } from '@ziga/shared/ids';
import { Auth } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import type { AccessClaims } from './token.service.js';

@Controller()
export class MeController {
	constructor(private readonly auth: AuthService) {}

	@Get('me')
	me(@Auth() claims: AccessClaims) {
		return this.auth.me(claims.sub);
	}

	@Get('sessions')
	sessions(@Auth() claims: AccessClaims) {
		return this.auth.listSessions(claims.sub, claims.sid);
	}

	@Delete('sessions/:id')
	@HttpCode(204)
	async revoke(@Auth() claims: AccessClaims, @Param('id') id: string) {
		await this.auth.revokeSession(claims.sub, idSchema.parse(id));
	}
}
