/** Lecture paginée du journal d'audit, limitée par la RLS au contexte de la transaction. */
import { isUuid } from '@ziga/shared/ids';
import type { AuditEntryView } from '@ziga/shared/organizations';
import { and, desc, eq, lt, type SQL } from 'drizzle-orm';
import { AppError } from '../../common/app-error.js';
import type { Tx } from '../../db/database.js';
import { users } from '../../db/schema/identity.js';
import { auditLog } from '../../db/schema/organizations.js';

/** Page du journal visible dans le contexte courant (organisation, ou événements de plateforme de la personne). */
export async function auditPage(
	tx: Tx,
	cursor: string | undefined,
	limit: number,
	extra: SQL[]
): Promise<{ entries: AuditEntryView[]; next: string | null }> {
	const conditions = [...extra];
	if (cursor) {
		if (!isUuid(cursor)) throw new AppError('BAD_REQUEST', 'Curseur invalide.', 400);
		conditions.push(lt(auditLog.id, cursor));
	}
	const rows = await tx
		.select({ a: auditLog, actorName: users.name })
		.from(auditLog)
		.leftJoin(users, eq(users.id, auditLog.actorUserId))
		.where(conditions.length ? and(...conditions) : undefined)
		.orderBy(desc(auditLog.id))
		.limit(limit + 1);
	const page = rows.slice(0, limit);
	return {
		entries: page.map(({ a, actorName }) => ({
			id: a.id,
			occurredAt: a.occurredAt.toISOString(),
			actorName: actorName ?? null,
			actorRole: a.actorRole,
			action: a.action,
			objectType: a.objectType,
			objectId: a.objectId,
			before: a.before,
			after: a.after,
			origin: a.origin,
			requestId: a.requestId,
			organizationId: a.organizationId,
			subjectUserId: a.subjectUserId
		})),
		next: rows.length > limit ? (page.at(-1)?.a.id ?? null) : null
	};
}
