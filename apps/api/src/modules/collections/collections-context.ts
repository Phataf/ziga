/** Contexte d'une requête du module collections (lot 10) : transaction, organisation, rôle, formule, auteur. */
import type { OrganizationRole, OrganizationType } from '@ziga/shared/permissions';
import { RequestContext } from '../../common/request-context.js';
import type { Tx } from '../../db/database.js';
import type { AuditActor } from '../audit/audit.service.js';

export interface CollectionsContext {
	tx: Tx;
	organizationId: string;
	organizationType: OrganizationType;
	role: OrganizationRole;
	planId: string;
	userId: string;
	actor: AuditActor;
}

export function collectionsContext(): CollectionsContext {
	const scope = RequestContext.organization();
	const userId = RequestContext.get()!.userId!;
	return {
		tx: RequestContext.tx(),
		organizationId: scope.organizationId,
		organizationType: scope.organizationType,
		role: scope.role,
		planId: scope.planId,
		userId,
		actor: { type: 'user', userId, role: scope.role }
	};
}

export const iso = (d: Date | null) => (d ? d.toISOString() : null);
