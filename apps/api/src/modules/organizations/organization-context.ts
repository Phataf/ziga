/**
 * Contexte d'organisation (lot 03, CLAUDE.md règle 1) :
 * - @OrganizationScoped() : la route exige l'en-tête X-Organization-Id d'une organisation dont la personne est
 *   membre active ; l'appartenance est relue à chaque requête (un membre retiré perd l'accès aussitôt) ;
 * - @Can('action') : la permission du rôle, d'après la matrice de packages/shared (403 FORBIDDEN_ACTION) ;
 * - l'intercepteur ouvre withOrganization() autour du handler et range la transaction dans RequestContext.
 */
import {
	applyDecorators,
	CanActivate,
	ExecutionContext,
	Injectable,
	SetMetadata,
	UseGuards,
	UseInterceptors,
	type CallHandler,
	type NestInterceptor
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isUuid } from '@ziga/shared/ids';
import { can, type Action, type OrganizationRole, type OrganizationType } from '@ziga/shared/permissions';
import { and, eq } from 'drizzle-orm';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { AppError } from '../../common/app-error.js';
import { RequestContext, type OrganizationScope } from '../../common/request-context.js';
import { DatabaseService } from '../../db/database.module.js';
import { organizationMembers, organizations } from '../../db/schema/organizations.js';
import type { AuthenticatedRequest } from '../identity/auth.guard.js';

export const ORGANIZATION_HEADER = 'x-organization-id';
const CAN = 'ziga:can';

export interface OrganizationRequest extends AuthenticatedRequest {
	organization?: OrganizationScope;
}

/** Permission exigée par la route, vérifiée côté serveur (CLAUDE.md §6). */
export const Can = (action: Action) => SetMetadata(CAN, action);

/** Le rôle permet-il l'action ? Sinon 403 FORBIDDEN_ACTION. */
export function assertCan(role: OrganizationRole, action: Action): void {
	if (!can(role, action)) throw new AppError('FORBIDDEN_ACTION', 'Votre rôle ne permet pas cette action.', 403, { action });
}

@Injectable()
export class OrganizationGuard implements CanActivate {
	constructor(
		private readonly reflector: Reflector,
		private readonly database: DatabaseService
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest<OrganizationRequest>();
		const userId = request.auth?.sub;
		if (!userId) throw new AppError('UNAUTHORIZED', 'Authentification requise.', 401);
		const header = request.headers[ORGANIZATION_HEADER];
		const organizationId = typeof header === 'string' ? header : undefined;
		if (!organizationId || !isUuid(organizationId)) {
			throw new AppError('ORGANIZATION_REQUIRED', 'Choisissez d’abord une organisation.', 400);
		}
		// Contexte personnel : la personne ne lit que ses propres appartenances (RLS own_memberships).
		const [membership] = await this.database.withUser(userId, (tx) =>
			tx
				.select({ memberId: organizationMembers.id, role: organizationMembers.role, type: organizations.type })
				.from(organizationMembers)
				.innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
				.where(
					and(
						eq(organizationMembers.organizationId, organizationId),
						eq(organizationMembers.userId, userId),
						eq(organizationMembers.status, 'active')
					)
				)
				.limit(1)
		);
		if (!membership) throw new AppError('NOT_A_MEMBER', 'Vous n’êtes pas membre de cette organisation.', 403);
		request.organization = {
			organizationId,
			organizationType: membership.type as OrganizationType,
			role: membership.role as OrganizationRole,
			memberId: membership.memberId
		};
		const action = this.reflector.getAllAndOverride<Action | undefined>(CAN, [context.getHandler(), context.getClass()]);
		if (action) assertCan(request.organization.role, action);
		return true;
	}
}

@Injectable()
export class OrganizationTransactionInterceptor implements NestInterceptor {
	constructor(private readonly database: DatabaseService) {}

	intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
		const request = context.switchToHttp().getRequest<OrganizationRequest>();
		const scope = request.organization!;
		const parent = RequestContext.get();
		const afterCommit: (() => Promise<void> | void)[] = [];
		const run = async () => {
			const result = await this.database.withOrganization(scope.organizationId, (tx) =>
				RequestContext.run(
					{ origin: parent?.origin ?? 'api', ...parent, userId: request.auth!.sub, organization: scope, tx, afterCommit },
					() => lastValueFrom(next.handle(), { defaultValue: undefined })
				)
			);
			// Après validation seulement : une tâche de fond ne voit jamais une écriture annulée.
			for (const fn of afterCommit) await fn();
			return result;
		};
		return from(run());
	}
}

/** Route d'organisation : membre actif exigé, transaction withOrganization ouverte autour du handler. */
export const OrganizationScoped = () => applyDecorators(UseGuards(OrganizationGuard), UseInterceptors(OrganizationTransactionInterceptor));
