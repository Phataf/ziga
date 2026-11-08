/**
 * Garde global (APP_GUARD) : toute route exige un jeton d'accès valide, sauf celles marquées @Public().
 * Les exceptions sont explicites : authentification, santé, clés publiques.
 */
import { CanActivate, ExecutionContext, Injectable, SetMetadata, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppError } from '../../common/app-error.js';
import { TokenService, type AccessClaims } from './token.service.js';

export const IS_PUBLIC = 'ziga:public';

/** Route accessible sans jeton d'accès. À utiliser avec parcimonie : chaque usage est une exception explicite. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export interface AuthenticatedRequest extends Request {
	auth?: AccessClaims;
}

/** Personne et session du jeton d'accès. */
export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AccessClaims => {
	return ctx.switchToHttp().getRequest<AuthenticatedRequest>().auth!;
});

@Injectable()
export class AuthGuard implements CanActivate {
	constructor(
		private readonly reflector: Reflector,
		private readonly tokens: TokenService
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;
		const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
		const header = request.headers.authorization;
		const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
		const claims = token ? await this.tokens.verify(token) : null;
		if (!claims) throw new AppError('UNAUTHORIZED', 'Authentification requise.', 401);
		request.auth = claims;
		return true;
	}
}
