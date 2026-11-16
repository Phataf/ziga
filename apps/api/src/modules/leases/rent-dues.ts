/**
 * Échéances côté serveur (lot 08) : le serveur est le seul à écrire `rent_dues`. Ces fonctions servent au service du
 * module (validation du bail, changement de loyer, annulation) et à la tâche quotidienne ; elles prennent la
 * transaction de l'organisation (RLS) et écrivent leur audit.
 *
 * - Génération : la même fonction pure que l'aperçu de l'appareil (packages/shared, generateRentSchedule), puis
 *   `INSERT … ON CONFLICT (organization_id, lease_id, period_start) DO NOTHING` : un rejeu, une double
 *   synchronisation ou la tâche de nuit ne créent jamais de doublon.
 * - Statut : `rentDueStatus` (à venir, due à sa date, en retard le lendemain ; une somme due à la signature n'est en
 *   retard qu'à partir du début du bail, `rentDueOverdueFrom`) ; seules les échéances non soldées avancent.
 */
import { newId } from '@ziga/shared/ids';
import { leaseOccupancySignal, rentDueOverdueFrom, rentDueStatus, type LeaseStatus } from '@ziga/shared/leases';
import type { OccupancySignal } from '@ziga/shared/properties';
import { generateRentSchedule, scheduleUntil, type RentDueDraft, type RentRate, type RentScheduleInput } from '@ziga/shared/rent-schedule';
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import type { AuditOrigin } from '../../common/request-context.js';
import type { Tx } from '../../db/database.js';
import { leases, leaseVersions, rentDues } from '../../db/schema/leases.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';

export type LeaseRow = typeof leases.$inferSelect;
export type RentDueRow = typeof rentDues.$inferSelect;

/** Statuts validés : ceux qui ont des échéances. */
export const VALIDATED_STATUSES = ['signed', 'active', 'notice'] as const satisfies readonly LeaseStatus[];

/** Entrée de l'échéancier pour un bail validé, avec ses tarifs successifs (versions copiées par la base). */
export async function scheduleInput(tx: Tx, lease: LeaseRow, until: string): Promise<RentScheduleInput> {
	const versions = await tx
		.select({
			version: leaseVersions.version,
			rentEffectiveFrom: leaseVersions.rentEffectiveFrom,
			rent: leaseVersions.rent,
			charges: leaseVersions.charges
		})
		.from(leaseVersions)
		.where(and(eq(leaseVersions.organizationId, lease.organizationId), eq(leaseVersions.leaseId, lease.id)))
		.orderBy(asc(leaseVersions.version));
	return {
		billingMode: lease.billingMode,
		periodicity: lease.periodicity,
		startOn: lease.startsOn,
		endOn: lease.endsOn,
		duesStartOn: lease.duesStartOn,
		dueDay: lease.dueDay,
		advanceMonths: lease.advanceMonths,
		activatedOn: lease.activatedOn!,
		// Un renouvellement (lot 08 bis) crée une version sans changer le loyer : même date d'effet que la précédente. On
		// garde, pour chaque date d'effet, la dernière version (tarifs strictement croissants pour l'échéancier).
		rates: versions.reduce<RentRate[]>((out, v) => {
			const rate = { effectiveFrom: v.rentEffectiveFrom, rent: v.rent, charges: v.charges, version: v.version };
			if (out.length && out[out.length - 1]!.effectiveFrom === v.rentEffectiveFrom) out[out.length - 1] = rate;
			else out.push(rate);
			return out;
		}, []),
		until
	};
}

export interface GenerationResult {
	inserted: number;
	firstPeriod: string | null;
	lastPeriod: string | null;
	total: number;
}

/** Insère les échéances manquantes d'un bail validé jusqu'à son horizon (fin du bail, ou 12 mois glissants). */
export async function insertMissingDues(tx: Tx, lease: LeaseRow, today: string): Promise<GenerationResult> {
	const input = await scheduleInput(tx, lease, scheduleUntil({ endOn: lease.endsOn, duesStartOn: lease.duesStartOn }, today));
	const drafts = generateRentSchedule(input);
	if (!drafts.length) return { inserted: 0, firstPeriod: null, lastPeriod: null, total: 0 };
	const rows = await tx
		.insert(rentDues)
		.values(
			drafts.map((d: RentDueDraft) => ({
				id: newId(),
				organizationId: lease.organizationId,
				leaseId: lease.id,
				periodStart: d.periodStart,
				periodEnd: d.periodEnd,
				dueOn: d.dueOn,
				rent: d.rent,
				charges: d.charges,
				amountDue: d.amountDue,
				amountPaid: 0,
				status: rentDueStatus(
					{ dueOn: d.dueOn, amountDue: d.amountDue, amountPaid: 0, overdueFrom: rentDueOverdueFrom(d, lease.startsOn) },
					today
				),
				prorated: d.prorated,
				isAdvance: d.isAdvance,
				leaseVersion: d.leaseVersion
			}))
		)
		.onConflictDoNothing({ target: [rentDues.organizationId, rentDues.leaseId, rentDues.periodStart] })
		.returning({ periodStart: rentDues.periodStart, amountDue: rentDues.amountDue });
	const periods = rows.map((r) => r.periodStart).sort();
	return {
		inserted: rows.length,
		firstPeriod: periods[0] ?? null,
		lastPeriod: periods.at(-1) ?? null,
		total: rows.reduce((sum, r) => sum + r.amountDue, 0)
	};
}

/** Génère et journalise (une ligne par bail et par passage, pas une par échéance). */
export async function generateDues(
	tx: Tx,
	audit: AuditService,
	lease: LeaseRow,
	today: string,
	actor: AuditActor,
	origin?: AuditOrigin
): Promise<GenerationResult> {
	const result = await insertMissingDues(tx, lease, today);
	if (result.inserted > 0) {
		await audit.record(tx, {
			actor,
			organizationId: lease.organizationId,
			action: 'rent_dues.generate',
			objectType: 'lease',
			objectId: lease.id,
			after: { ...result, leaseVersion: lease.version },
			...(origin ? { origin } : {})
		});
	}
	return result;
}

/**
 * Fait avancer le statut des échéances non soldées au jour `today` (due à sa date, en retard le lendemain ; une somme
 * due à la signature, en retard à partir du début du bail). Une ligne d'audit par échéance qui change. `leaseIds` : seulement ces baux ; sinon toute l'organisation.
 */
export async function refreshDueStatuses(
	tx: Tx,
	audit: AuditService,
	organizationId: string,
	today: string,
	actor: AuditActor,
	origin?: AuditOrigin,
	leaseIds?: readonly string[]
): Promise<number> {
	if (leaseIds && !leaseIds.length) return 0;
	const rows = await tx
		.select({ due: rentDues, leaseStartsOn: leases.startsOn })
		.from(rentDues)
		.innerJoin(leases, and(eq(leases.organizationId, rentDues.organizationId), eq(leases.id, rentDues.leaseId)))
		.where(
			and(
				eq(rentDues.organizationId, organizationId),
				inArray(rentDues.status, ['upcoming', 'due', 'partial']),
				lte(rentDues.dueOn, today),
				leaseIds ? inArray(rentDues.leaseId, [...leaseIds]) : undefined
			)
		)
		.orderBy(asc(rentDues.id))
		.for('update', { of: rentDues });
	let changed = 0;
	for (const { due: row, leaseStartsOn } of rows) {
		const next = rentDueStatus({ ...row, overdueFrom: rentDueOverdueFrom(row, leaseStartsOn) }, today);
		if (next === row.status) continue;
		await tx
			.update(rentDues)
			.set({ status: next, updatedAt: new Date() })
			.where(and(eq(rentDues.organizationId, organizationId), eq(rentDues.id, row.id)));
		await audit.record(tx, {
			actor,
			organizationId,
			action: 'rent_due.status',
			objectType: 'rent_due',
			objectId: row.id,
			before: { status: row.status },
			after: { status: next, leaseId: row.leaseId, periodStart: row.periodStart, dueOn: row.dueOn },
			...(origin ? { origin } : {})
		});
		changed += 1;
	}
	return changed;
}

/** Lecteur d'occupation inscrit auprès du module properties : signaux des baux de chaque unité (règle 13). */
export async function occupancySignals(
	tx: Tx,
	organizationId: string,
	unitIds: readonly string[],
	today: string
): Promise<Map<string, OccupancySignal[]>> {
	const rows = await tx
		.select({ unitId: leases.unitId, status: leases.status, startsOn: leases.startsOn })
		.from(leases)
		.where(
			and(eq(leases.organizationId, organizationId), inArray(leases.unitId, [...unitIds]), inArray(leases.status, [...VALIDATED_STATUSES]))
		);
	const out = new Map<string, OccupancySignal[]>();
	for (const r of rows) {
		const signal = leaseOccupancySignal(r, today);
		if (!signal) continue;
		out.set(r.unitId, [...(out.get(r.unitId) ?? []), signal]);
	}
	return out;
}

/**
 * Renouvellement du bail (lot 08 bis) : sa version suivante, avec la nouvelle fin (ou durée indéterminée) et la date du
 * renouvellement ; même compte de caution, même historique ; les échéances manquantes sont créées. Un seul chemin pour
 * l'avenant de renouvellement signé et pour la reconduction au terme sans congé (tâche de nuit). La base vérifie la
 * version et la fin postérieure (leases_rules).
 */
export async function renewLease(
	tx: Tx,
	audit: AuditService,
	lease: LeaseRow,
	change: { newEndsOn: string | null; renewedOn: string; automatic: boolean; amendmentId?: string | null },
	today: string,
	actor: AuditActor,
	origin?: AuditOrigin
): Promise<LeaseRow> {
	const [updated] = await tx
		.update(leases)
		.set({
			endsOn: change.newEndsOn,
			lastRenewedOn: change.renewedOn,
			lastRenewalAutomatic: change.automatic,
			version: lease.version + 1,
			updatedBy: actor.type === 'user' ? actor.userId : null,
			updatedAt: new Date()
		})
		.where(and(eq(leases.organizationId, lease.organizationId), eq(leases.id, lease.id)))
		.returning();
	await audit.record(tx, {
		actor,
		organizationId: lease.organizationId,
		action: change.automatic ? 'lease.renew_automatic' : 'lease.renew',
		objectType: 'lease',
		objectId: lease.id,
		before: { endsOn: lease.endsOn, version: lease.version },
		after: {
			endsOn: change.newEndsOn,
			renewedOn: change.renewedOn,
			version: lease.version + 1,
			renewalMode: lease.renewalMode,
			amendmentId: change.amendmentId ?? null
		},
		origin
	});
	await generateDues(tx, audit, updated!, today, actor, origin);
	return updated!;
}
