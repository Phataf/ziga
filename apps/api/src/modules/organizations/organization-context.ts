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
import { RequestContext, type AuditOrigin, type OrganizationScope } from '../../common/request-context.js';
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

/**
 * Appartenance active de la personne à l'organisation, avec la formule et le statut de celle-ci, lue en contexte
 * personnel (RLS own_memberships et own_organizations). Service public du module organizations.
 */
export async function loadMembershipScope(
	database: DatabaseService,
	userId: string,
	organizationId: string
): Promise<OrganizationScope | null> {
	const [membership] = await database.withUser(userId, (tx) =>
		tx
			.select({
				memberId: organizationMembers.id,
				role: organizationMembers.role,
				type: organizations.type,
				planId: organizations.planId,
				verificationStatus: organizations.verificationStatus
			})
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
	if (!membership) return null;
	return {
		organizationId,
		organizationType: membership.type as OrganizationType,
		role: membership.role as OrganizationRole,
		memberId: membership.memberId,
		planId: membership.planId,
		verificationStatus: membership.verificationStatus
	};
}

/** Membre actif de l'organisation, sinon 403 NOT_A_MEMBER. Partagé par les routes et l'envoi des modifications (lot 05). */
export async function requireMembership(database: DatabaseService, userId: string, organizationId: string): Promise<OrganizationScope> {
	const scope = await loadMembershipScope(database, userId, organizationId);
	if (!scope) throw new AppError('NOT_A_MEMBER', 'Vous n’êtes pas membre de cette organisation.', 403);
	return scope;
}

/** Organisation suspendue : consultation et export seulement, ni création ni modification (403 ORGANIZATION_SUSPENDED). */
export function assertWritable(scope: OrganizationScope): void {
	if (scope.verificationStatus === 'suspended') {
		throw new AppError(
			'ORGANIZATION_SUSPENDED',
			'Organisation suspendue : la consultation et l’export restent possibles, pas les modifications.',
			403
		);
	}
}

/**
 * Transaction withOrganization() et contexte de requête (personne, organisation, origine de l'audit), puis les tâches
 * prévues après validation. Partagé par l'intercepteur des routes et l'envoi des modifications (origine `sync`).
 */
export async function runInOrganization<T>(
	database: DatabaseService,
	scope: OrganizationScope,
	userId: string,
	fn: () => Promise<T>,
	origin?: AuditOrigin
): Promise<T> {
	const parent = RequestContext.get();
	const afterCommit: (() => Promise<void> | void)[] = [];
	const result = await database.withOrganization(scope.organizationId, (tx) =>
		RequestContext.run({ ...parent, origin: origin ?? parent?.origin ?? 'api', userId, organization: scope, tx, afterCommit }, fn)
	);
	// Après validation seulement : une tâche de fond ne voit jamais une écriture annulée.
	for (const task of afterCommit) await task();
	return result;
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
		const scope = await requireMembership(this.database, userId, organizationId);
		if (request.method !== 'GET') assertWritable(scope);
		request.organization = scope;
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
		return from(
			runInOrganization(this.database, request.organization!, request.auth!.sub, () =>
				lastValueFrom(next.handle(), { defaultValue: undefined })
			)
		);
	}
}

/** Route d'organisation : membre actif exigé, transaction withOrganization ouverte autour du handler. */
export const OrganizationScoped = () => applyDecorators(UseGuards(OrganizationGuard), UseInterceptors(OrganizationTransactionInterceptor));
