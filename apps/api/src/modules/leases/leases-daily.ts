/**
 * Tâche quotidienne des baux (lot 08), dans le worker, chaque organisation concernée dans son propre contexte (RLS) :
 * - un bail signé dont la date de début est arrivée devient « en vigueur » ; s'il reste un bail en vigueur sur l'unité
 *   (préavis pas encore terminé, lot 10 bis), il attend et l'audit le dit (la règle 8 n'est jamais contournée) ;
 * - un bail sans fin reçoit ses échéances sur 12 mois glissants (sans doublon : clé bail + période) ;
 * - une échéance devient due à sa date et passe en retard le lendemain si elle n'est pas soldée.
 * - lot 10 bis : à la date de sortie, le bail en préavis se termine ; la dernière période est ramenée au dernier jour
 *   facturé selon le mode du bail, les échéances suivantes sont abandonnées, le surplus déjà payé revient au crédit du
 *   bail (D32) ; la base fait passer l'unité « à remettre en état » (D14). Un décompte pas encore clos reçoit son alerte
 *   avant la fin du délai de restitution (une ligne d'audit par niveau atteint).
 * Idempotente : relancée le même jour, elle ne change rien.
 * Les organisations viennent de due_lease_organizations (SECURITY DEFINER, seulement des identifiants).
 */
import { automaticRenewalEnd } from '@ziga/shared/contracts';
import { addDays } from '@ziga/shared/dates';
import { refundAlert } from '@ziga/shared/deposit-settlement';
import { generateRentSchedule } from '@ziga/shared/rent-schedule';
import { exitDueAdjustments, type ExitDueAdjustment } from '@ziga/shared/tenant-exit';
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, ne, sql } from 'drizzle-orm';
import type { DatabaseService } from '../../db/database.module.js';
import type { Tx } from '../../db/database.js';
import { depositSettlements, leaseNotices, leases, rentDues } from '../../db/schema/leases.js';
import type { AuditOrigin } from '../../common/request-context.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';
import type { ExitHooks } from './exit-hooks.js';
import type { RentDueEvents } from './rent-due-events.js';
import { generateDues, refreshDueStatuses, renewLease, scheduleInput } from './rent-dues.js';

const SYSTEM: AuditActor = { type: 'system' };

export interface LeasesDailyResult {
	activated: number;
	waiting: number;
	generated: number;
	statuses: number;
	/** Lot 08 bis : baux arrivés à leur terme sans congé, reconduits selon leur paramètre (D24). */
	renewed: number;
	/** Lot 10 bis : baux terminés à leur date de sortie ; alertes du délai de restitution. */
	ended: number;
	refundAlerts: number;
}

/**
 * Dernières échéances d'un bail à sa sortie (D32), sans rien écrire : le dernier mois ramené au dernier jour facturé
 * selon le mode du bail, les suivants abandonnés, le surplus déjà payé rendu au crédit. La même règle pour la tâche du
 * jour (qui l'écrit) et pour un décompte préparé avant elle (qui la lit) : le décompte ne dépend jamais de la tâche.
 */
export async function exitDuesPlan(
	tx: Tx,
	lease: typeof leases.$inferSelect,
	lock = false
): Promise<{ rentEndsOn: string; origin: string | null; adjustments: ExitDueAdjustment[] }> {
	const [notice] = await tx
		.select()
		.from(leaseNotices)
		.where(and(eq(leaseNotices.leaseId, lease.id), eq(leaseNotices.status, 'recorded')))
		.limit(1);
	const rentEndsOn = notice?.rentEndsOn ?? lease.exitOn!;
	if (rentEndsOn < lease.duesStartOn) return { rentEndsOn, origin: notice?.origin ?? null, adjustments: [] };
	const input = await scheduleInput(tx, lease, rentEndsOn);
	const endOn = lease.endsOn && lease.endsOn < rentEndsOn ? lease.endsOn : rentEndsOn;
	const regenerated = generateRentSchedule({ ...input, endOn, until: rentEndsOn });
	// Lot 11 : l'échéance « Solde antérieur » n'est ni raccourcie ni abandonnée à la sortie ; elle reste due.
	const q = tx
		.select()
		.from(rentDues)
		.where(and(eq(rentDues.leaseId, lease.id), eq(rentDues.kind, 'rent')));
	const rows = lock ? await q.for('update') : await q;
	return { rentEndsOn, origin: notice?.origin ?? null, adjustments: exitDueAdjustments(rows, regenerated, rentEndsOn) };
}

/**
 * Fin d'un bail en préavis arrivé à sa date de sortie : dernières échéances écrites (une fois, `exit_adjusted_at`),
 * surplus rendu au crédit, bail terminé (la base fait passer l'unité « à remettre en état »), journalisé. Appelée par
 * la tâche du jour et à la préparation du décompte ; sans effet sur un bail déjà terminé ou pas encore à sa sortie.
 */
export async function endLeaseAtExit(
	tx: Tx,
	audit: AuditService,
	organizationId: string,
	lease: typeof leases.$inferSelect,
	today: string,
	hooks: ExitHooks,
	actor: AuditActor = SYSTEM,
	origin: AuditOrigin = 'job'
): Promise<boolean> {
	if (lease.status !== 'notice' || !lease.exitOn || lease.exitOn > today) return false;
	const plan = await exitDuesPlan(tx, lease, true);
	const now = new Date();
	const adjustments: { id: string; action: string; amountDue: number; excessPaid: number }[] = [];
	for (const a of plan.adjustments) {
		// Surplus déjà payé : l'argent du locataire, rendu au crédit du bail avant de réduire l'échéance.
		if (a.excessPaid > 0) {
			await hooks.payments.releaseToCredit({ tx, organizationId, leaseId: lease.id, rentDueId: a.id, amount: a.excessPaid, actor, today });
		}
		await tx
			.update(rentDues)
			.set(
				a.action === 'waive'
					? { status: 'waived', exitAdjustedAt: now, updatedAt: now }
					: {
							rent: a.rent,
							charges: a.charges,
							amountDue: a.amountDue,
							periodEnd: a.periodEnd,
							prorated: true,
							exitAdjustedAt: now,
							updatedAt: now
						}
			)
			.where(eq(rentDues.id, a.id));
		adjustments.push({ id: a.id, action: a.action, amountDue: a.amountDue, excessPaid: a.excessPaid });
	}
	const endKind = plan.origin === 'lessor' ? 'lessor_notice' : 'tenant_exit';
	await tx
		.update(leases)
		.set({ status: 'ended', endedAt: now, endKind, endReason: 'Sortie du locataire', updatedAt: now })
		.where(eq(leases.id, lease.id));
	await audit.record(tx, {
		actor,
		organizationId,
		action: 'lease.end',
		objectType: 'lease',
		objectId: lease.id,
		before: { status: 'notice' },
		after: { status: 'ended', endKind, exitOn: lease.exitOn, rentEndsOn: plan.rentEndsOn, adjustments },
		origin
	});
	return true;
}

/**
 * Lot 10 bis : fin des baux en préavis arrivés à leur date de sortie, et alertes du délai de restitution. Rejouée le même
 * jour, elle ne change rien (le bail est terminé, l'ajustement de la dernière période n'a lieu qu'une fois).
 */
export async function exitLeasesFor(
	tx: Tx,
	audit: AuditService,
	organizationId: string,
	today: string,
	hooks: ExitHooks
): Promise<{ ended: number; refundAlerts: number }> {
	let ended = 0;
	const due = await tx
		.select()
		.from(leases)
		.where(and(eq(leases.organizationId, organizationId), eq(leases.status, 'notice'), lte(leases.exitOn, today)))
		.orderBy(asc(leases.exitOn), asc(leases.id))
		.for('update');
	for (const lease of due) if (await endLeaseAtExit(tx, audit, organizationId, lease, today, hooks)) ended += 1;
	let refundAlerts = 0;
	const open = await tx
		.select()
		.from(depositSettlements)
		.where(and(eq(depositSettlements.organizationId, organizationId), ne(depositSettlements.status, 'closed')))
		.for('update');
	for (const s of open) {
		const level = refundAlert(today, s.refundDeadline, false);
		if (level === 'none' || level === s.refundAlert) continue;
		await tx.update(depositSettlements).set({ refundAlert: level, updatedAt: new Date() }).where(eq(depositSettlements.id, s.id));
		await audit.record(tx, {
			actor: SYSTEM,
			organizationId,
			action: level === 'soon' ? 'deposit.refund_deadline_soon' : 'deposit.refund_deadline_overdue',
			objectType: 'deposit_settlement',
			objectId: s.id,
			after: { refundDeadline: s.refundDeadline, level },
			origin: 'job'
		});
		refundAlerts += 1;
	}
	return { ended, refundAlerts };
}

function isUniqueViolation(error: unknown): boolean {
	let current: unknown = error;
	for (let i = 0; i < 4 && current; i += 1) {
		if ((current as { code?: string }).code === '23505') return true;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

export async function leasesDailyFor(
	tx: Tx,
	audit: AuditService,
	organizationId: string,
	today: string,
	/** Obligatoire : sans lui, le surplus déjà payé ne reviendrait pas au crédit du locataire. */
	hooks: ExitHooks,
	events?: RentDueEvents
): Promise<LeasesDailyResult> {
	const result: LeasesDailyResult = { activated: 0, waiting: 0, generated: 0, statuses: 0, renewed: 0, ended: 0, refundAlerts: 0 };
	// Lot 10 bis : les sorties d'abord, pour qu'un bail à venir sur la même unité puisse entrer en vigueur ce jour-là.
	const exit = await exitLeasesFor(tx, audit, organizationId, today, hooks);
	result.ended = exit.ended;
	result.refundAlerts = exit.refundAlerts;
	const starting = await tx
		.select()
		.from(leases)
		.where(and(eq(leases.organizationId, organizationId), eq(leases.status, 'signed'), lte(leases.startsOn, today)))
		.orderBy(asc(leases.startsOn), asc(leases.id))
		.for('update');
	for (const lease of starting) {
		try {
			// Point de sauvegarde : un refus de l'index (règle 8) n'annule pas le reste de la tâche.
			await tx.transaction(async (sp) => {
				await sp
					.update(leases)
					.set({ status: 'active', updatedAt: new Date() })
					.where(and(eq(leases.organizationId, organizationId), eq(leases.id, lease.id)));
			});
			await audit.record(tx, {
				actor: SYSTEM,
				organizationId,
				action: 'lease.activate',
				objectType: 'lease',
				objectId: lease.id,
				before: { status: 'signed' },
				after: { status: 'active', startsOn: lease.startsOn },
				origin: 'job'
			});
			result.activated += 1;
		} catch (error) {
			if (!isUniqueViolation(error)) throw error;
			await audit.record(tx, {
				actor: SYSTEM,
				organizationId,
				action: 'lease.activation_waiting',
				objectType: 'lease',
				objectId: lease.id,
				after: { status: 'signed', startsOn: lease.startsOn, reason: 'UNIT_ALREADY_LEASED' },
				origin: 'job'
			});
			result.waiting += 1;
		}
	}
	// Terme atteint sans congé : reconduction selon le bail (durée indéterminée, ou même durée), journalisée ; une tâche
	// manquée plusieurs fois rattrape les périodes l'une après l'autre (une version chacune).
	const ended = await tx
		.select()
		.from(leases)
		.where(
			and(
				eq(leases.organizationId, organizationId),
				eq(leases.status, 'active'),
				isNotNull(leases.endsOn),
				lt(leases.endsOn, today),
				isNull(leases.noticeGivenOn)
			)
		)
		.orderBy(asc(leases.id))
		.for('update');
	for (let lease of ended) {
		while (lease.endsOn && lease.endsOn < today) {
			const newEndsOn = automaticRenewalEnd({ ...lease, endsOn: lease.endsOn });
			lease = await renewLease(
				tx,
				audit,
				lease,
				{ newEndsOn, renewedOn: addDays(lease.endsOn, 1), automatic: true },
				today,
				SYSTEM,
				'job',
				events
			);
		}
		result.renewed += 1;
	}
	const openEnded = await tx
		.select()
		.from(leases)
		// Un bail en préavis ne reçoit plus d'échéances glissantes : elles s'arrêtent au dernier jour facturé (lot 10 bis).
		.where(and(eq(leases.organizationId, organizationId), inArray(leases.status, ['signed', 'active']), isNull(leases.endsOn)))
		.orderBy(asc(leases.id));
	for (const lease of openEnded) result.generated += (await generateDues(tx, audit, lease, today, SYSTEM, 'job', events)).inserted;
	result.statuses = await refreshDueStatuses(tx, audit, organizationId, today, SYSTEM, 'job');
	return result;
}

/** Tâche de nuit : chaque organisation concernée, l'une après l'autre, chacune dans son contexte. */
export async function runLeasesDaily(
	database: DatabaseService,
	audit: AuditService,
	today: string,
	/** Obligatoire : sans lui, le surplus déjà payé ne reviendrait pas au crédit du locataire. */
	hooks: ExitHooks,
	events?: RentDueEvents
): Promise<LeasesDailyResult & { organizations: number }> {
	const r = await database.db.execute<{ id: string }>(sql`select due_lease_organizations(${today}::date) as id`);
	const total: LeasesDailyResult & { organizations: number } = {
		organizations: r.rows.length,
		activated: 0,
		waiting: 0,
		generated: 0,
		statuses: 0,
		renewed: 0,
		ended: 0,
		refundAlerts: 0
	};
	for (const { id } of r.rows) {
		const one = await database.withOrganization(id, (tx) => leasesDailyFor(tx, audit, id, today, hooks, events));
		total.activated += one.activated;
		total.waiting += one.waiting;
		total.generated += one.generated;
		total.statuses += one.statuses;
		total.renewed += one.renewed;
		total.ended += one.ended;
		total.refundAlerts += one.refundAlerts;
	}
	return total;
}
