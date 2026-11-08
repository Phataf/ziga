/** Routes de la personne connectée (« Mon compte ») : protégées par le garde global. */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { idSchema } from '@ziga/shared/ids';
import { changePasswordSchema, changePhoneSchema, confirmPhoneSchema, updateProfileSchema } from '@ziga/shared/organizations';
import { isNull } from 'drizzle-orm';
import type { Request } from 'express';
import { DatabaseService } from '../../db/database.module.js';
import { auditLog } from '../../db/schema/organizations.js';
import { auditPage } from '../audit/audit-page.js';
import { Auth } from './auth.guard.js';
import { AuthService, type ClientInfo } from './auth.service.js';
import type { AccessClaims } from './token.service.js';

function client(request: Request): ClientInfo {
	return { ip: request.ip ?? 'inconnue', userAgent: request.headers['user-agent'] };
}

@Controller()
export class MeController {
	constructor(
		private readonly auth: AuthService,
		private readonly database: DatabaseService
	) {}

	@Get('me')
	me(@Auth() claims: AccessClaims) {
		return this.auth.me(claims.sub);
	}

	@Patch('me')
	updateName(@Auth() claims: AccessClaims, @Body() body: unknown) {
		return this.auth.updateName(claims.sub, updateProfileSchema.parse(body).name);
	}

	@Post('me/password')
	@HttpCode(204)
	async changePassword(@Auth() claims: AccessClaims, @Body() body: unknown, @Req() req: Request) {
		await this.auth.changePassword(claims.sub, claims.sid, changePasswordSchema.parse(body), client(req));
	}

	@Post('me/phone')
	@HttpCode(202)
	async requestPhoneChange(@Auth() claims: AccessClaims, @Body() body: unknown, @Req() req: Request) {
		await this.auth.requestPhoneChange(claims.sub, changePhoneSchema.parse(body), client(req));
		return { message: 'Si ce numéro peut recevoir un code, un SMS vient d’être envoyé.' };
	}

	@Post('me/phone/confirm')
	@HttpCode(200)
	confirmPhoneChange(@Auth() claims: AccessClaims, @Body() body: unknown, @Req() req: Request) {
		return this.auth.confirmPhoneChange(claims.sub, confirmPhoneSchema.parse(body), client(req));
	}

	/** Activité récente du compte : ses événements de plateforme seulement (RLS own_platform_events). */
	@Get('me/activity')
	activity(@Auth() claims: AccessClaims, @Query('avant') before?: string) {
		return this.database.withUser(claims.sub, (tx) => auditPage(tx, before || undefined, 30, [isNull(auditLog.organizationId)]));
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
