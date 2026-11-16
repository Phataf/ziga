/**
 * Tâche quotidienne des baux (lot 08), dans le worker, chaque organisation concernée dans son propre contexte (RLS) :
 * - un bail signé dont la date de début est arrivée devient « en vigueur » ; s'il reste un bail en vigueur sur l'unité
 *   (préavis pas encore terminé, lot 10 bis), il attend et l'audit le dit (la règle 8 n'est jamais contournée) ;
 * - un bail sans fin reçoit ses échéances sur 12 mois glissants (sans doublon : clé bail + période) ;
 * - une échéance devient due à sa date et passe en retard le lendemain si elle n'est pas soldée.
 * Idempotente : relancée le même jour, elle ne change rien.
 * Les organisations viennent de due_lease_organizations (SECURITY DEFINER, seulement des identifiants).
 */
import { automaticRenewalEnd } from '@ziga/shared/contracts';
import { addDays } from '@ziga/shared/dates';
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm';
import type { DatabaseService } from '../../db/database.module.js';
import type { Tx } from '../../db/database.js';
import { leases } from '../../db/schema/leases.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';
import { generateDues, refreshDueStatuses, renewLease } from './rent-dues.js';

const SYSTEM: AuditActor = { type: 'system' };

export interface LeasesDailyResult {
	activated: number;
	waiting: number;
	generated: number;
	statuses: number;
	/** Lot 08 bis : baux arrivés à leur terme sans congé, reconduits selon leur paramètre (D24). */
	renewed: number;
}

function isUniqueViolation(error: unknown): boolean {
	let current: unknown = error;
	for (let i = 0; i < 4 && current; i += 1) {
		if ((current as { code?: string }).code === '23505') return true;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

export async function leasesDailyFor(tx: Tx, audit: AuditService, organizationId: string, today: string): Promise<LeasesDailyResult> {
	const result: LeasesDailyResult = { activated: 0, waiting: 0, generated: 0, statuses: 0, renewed: 0 };
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
			lease = await renewLease(tx, audit, lease, { newEndsOn, renewedOn: addDays(lease.endsOn, 1), automatic: true }, today, SYSTEM, 'job');
		}
		result.renewed += 1;
	}
	const openEnded = await tx
		.select()
		.from(leases)
		.where(and(eq(leases.organizationId, organizationId), inArray(leases.status, ['signed', 'active', 'notice']), isNull(leases.endsOn)))
		.orderBy(asc(leases.id));
	for (const lease of openEnded) result.generated += (await generateDues(tx, audit, lease, today, SYSTEM, 'job')).inserted;
	result.statuses = await refreshDueStatuses(tx, audit, organizationId, today, SYSTEM, 'job');
	return result;
}

/** Tâche de nuit : chaque organisation concernée, l'une après l'autre, chacune dans son contexte. */
export async function runLeasesDaily(
	database: DatabaseService,
	audit: AuditService,
	today: string
): Promise<LeasesDailyResult & { organizations: number }> {
	const r = await database.db.execute<{ id: string }>(sql`select due_lease_organizations(${today}::date) as id`);
	const total: LeasesDailyResult & { organizations: number } = {
		organizations: r.rows.length,
		activated: 0,
		waiting: 0,
		generated: 0,
		statuses: 0,
		renewed: 0
	};
	for (const { id } of r.rows) {
		const one = await database.withOrganization(id, (tx) => leasesDailyFor(tx, audit, id, today));
		total.activated += one.activated;
		total.waiting += one.waiting;
		total.generated += one.generated;
		total.statuses += one.statuses;
		total.renewed += one.renewed;
	}
	return total;
}
