/**
 * Garde du back-office (lot 04) : `@PlatformCan(action)`. La personne doit avoir un rôle plateforme permettant
 * l'action (matrice PLATFORM_PERMISSIONS de packages/shared). Le rôle est relu en base à chaque requête : un rôle
 * retiré prend effet aussitôt, même avec un jeton d'accès encore valable. Une personne sans rôle reçoit 403.
 */
import { applyDecorators, CanActivate, ExecutionContext, Injectable, SetMetadata, UseGuards, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { platformCan, type PlatformAction, type PlatformRoleKey } from '@ziga/shared/permissions';
import { eq } from 'drizzle-orm';
import { AppError } from '../../common/app-error.js';
import { RequestContext } from '../../common/request-context.js';
import { users } from '../../db/schema/identity.js';
import type { AuthenticatedRequest } from '../identity/auth.guard.js';
import { AdminDatabase } from './admin-database.service.js';

const ACTION = 'ziga:platform-action';

export interface PlatformActor {
	userId: string;
	role: PlatformRoleKey;
}

interface PlatformRequest extends AuthenticatedRequest {
	platform?: PlatformActor;
}

@Injectable()
export class PlatformGuard implements CanActivate {
	constructor(
		private readonly reflector: Reflector,
		private readonly admin: AdminDatabase
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const action = this.reflector.getAllAndOverride<PlatformAction>(ACTION, [context.getHandler(), context.getClass()]);
		const request = context.switchToHttp().getRequest<PlatformRequest>();
		const userId = request.auth?.sub;
		if (!userId) throw new AppError('UNAUTHORIZED', 'Authentification requise.', 401);
		const [person] = await this.admin.transaction(
			(tx) => tx.select({ role: users.platformRole, status: users.status }).from(users).where(eq(users.id, userId)).limit(1),
			{ readOnly: true }
		);
		if (!person || person.status !== 'active' || !person.role)
			throw new AppError('PLATFORM_ONLY', 'Réservé à l’équipe de la plateforme.', 403);
		if (!platformCan(person.role, action))
			throw new AppError('FORBIDDEN_ACTION', 'Votre rôle ne permet pas cette action.', 403, { action });
		request.platform = { userId, role: person.role as PlatformRoleKey };
		const store = RequestContext.get();
		if (store) store.origin = 'admin';
		return true;
	}
}

/** Route du back-office : permission du rôle plateforme exigée. */
export const PlatformCan = (action: PlatformAction) => applyDecorators(SetMetadata(ACTION, action), UseGuards(PlatformGuard));

/** Personne du back-office qui agit (posée par le garde). */
export const Platform = createParamDecorator((_: unknown, ctx: ExecutionContext): PlatformActor => {
	return ctx.switchToHttp().getRequest<PlatformRequest>().platform!;
});
