/**
 * Expiration des mandats (lot 06) : un mandat actif dont la date de fin est passée devient « expired », ses
 * autorisations tombent à faux, et la base en garde une nouvelle version.
 * - La tâche de nuit (worker, BullMQ) trouve les organisations concernées par due_mandate_organizations (seulement des
 *   identifiants), puis ouvre chacune dans son propre contexte, sous la RLS.
 * - Avant de créer un mandat de gestion, le service applique les expirations dues de l'organisation dans la même
 *   transaction : un mandat arrivé à sa date de fin ne bloque pas l'unité en attendant la nuit.
 */
import { and, asc, eq, isNotNull, lt, sql } from 'drizzle-orm';
import type { AuditOrigin } from '../../common/request-context.js';
import type { DatabaseService } from '../../db/database.module.js';
import type { Tx } from '../../db/database.js';
import { mandates } from '../../db/schema/owners.js';
import type { AuditService } from '../audit/audit.service.js';

/** Expire, dans la transaction d'une organisation, ses mandats actifs dont la fin est avant `today`. */
export async function expireDueMandates(
	tx: Tx,
	audit: AuditService,
	organizationId: string,
	today: string,
	origin?: AuditOrigin
): Promise<number> {
	const due = await tx
		.select({ id: mandates.id, version: mandates.version, endsOn: mandates.endsOn })
		.from(mandates)
		.where(
			and(
				eq(mandates.organizationId, organizationId),
				eq(mandates.status, 'active'),
				isNotNull(mandates.endsOn),
				lt(mandates.endsOn, today)
			)
		)
		.orderBy(asc(mandates.id))
		.for('update');
	const now = new Date();
	for (const m of due) {
		await tx
			.update(mandates)
			.set({
				status: 'expired',
				expiredAt: now,
				canPublish: false,
				canTakePhotos: false,
				canCollectFunds: false,
				canSignLeases: false,
				version: m.version + 1,
				updatedBy: null,
				updatedAt: now
			})
			.where(and(eq(mandates.organizationId, organizationId), eq(mandates.id, m.id)));
		await audit.record(tx, {
			actor: { type: 'system' },
			organizationId,
			action: 'mandate.expire',
			objectType: 'mandate',
			objectId: m.id,
			before: { status: 'active', version: m.version },
			after: {
				status: 'expired',
				endsOn: m.endsOn,
				canPublish: false,
				canTakePhotos: false,
				canCollectFunds: false,
				canSignLeases: false,
				version: m.version + 1
			},
			...(origin ? { origin } : {})
		});
	}
	return due.length;
}

/** Tâche de nuit : chaque organisation qui a un mandat échu, l'une après l'autre, chacune dans son contexte. */
export async function expireAllDueMandates(
	database: DatabaseService,
	audit: AuditService,
	today: string
): Promise<{ organizations: number; mandates: number }> {
	const r = await database.db.execute<{ id: string }>(sql`select due_mandate_organizations(${today}::date) as id`);
	let count = 0;
	for (const { id } of r.rows) {
		count += await database.withOrganization(id, (tx) => expireDueMandates(tx, audit, id, today, 'job'));
	}
	return { organizations: r.rows.length, mandates: count };
}
