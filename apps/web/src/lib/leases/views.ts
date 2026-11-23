/**
 * Locataires, baux, échéances et cautions lus dans la base locale (lot 08) : lignes SQLite (booléens en 0 ou 1,
 * colonnes en snake_case) transformées en vues des écrans, les mêmes que celles de l'API. L'aperçu de l'échéancier
 * (bail créé hors ligne, pas encore validé par le serveur) vient de la même fonction pure que le serveur. Fonctions
 * pures, testées.
 */
import {
	depositAboveLegalCap,
	depositBalances,
	leaseAlerts,
	rentDueBalance,
	rentDueOverdueFrom,
	rentDueStatus,
	unitOccupancy,
	type DepositAccountView,
	type DepositMovementView,
	type LeaseStatus,
	type LeaseVersionView,
	type LeaseView,
	type RentDueView,
	type TenantIdentity,
	type TenantView
} from '@ziga/shared/leases';
import { isIsoDate } from '@ziga/shared/dates';
import type { Occupancy } from '@ziga/shared/properties';
import { generateRentSchedule, scheduleUntil, type RentDueDraft } from '@ziga/shared/rent-schedule';
import { normalize } from '../owners/views';

type Row = Record<string, unknown>;

const str = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
const int = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
const bool = (v: unknown) => v === 1 || v === true || v === '1';

export function toTenant(r: Row): TenantView {
	return {
		id: String(r.id),
		civility: str(r.civility) as TenantView['civility'],
		fullName: String(r.full_name ?? ''),
		phone: str(r.phone),
		secondaryPhone: str(r.secondary_phone),
		nationality: str(r.nationality),
		profession: str(r.profession),
		previousAddress: str(r.previous_address),
		emergencyContactName: str(r.emergency_contact_name),
		emergencyContactPhone: str(r.emergency_contact_phone),
		notes: str(r.notes),
		// Une fiche créée sur l'appareil n'a pas encore de statut renvoyé par le serveur : elle est active.
		status: r.status === 'archived' ? 'archived' : 'active',
		archivedAt: str(r.archived_at),
		createdAt: str(r.created_at) ?? '',
		updatedAt: str(r.updated_at) ?? ''
	};
}

/** État civil (stream réservé au directeur et au gestionnaire) ; null si la ligne n'a pas été reçue. */
export function toTenantIdentity(r: Row | undefined): TenantIdentity | null {
	if (!r) return null;
	return {
		birthDate: str(r.birth_date),
		birthPlace: str(r.birth_place),
		idType: str(r.id_type) as TenantIdentity['idType'],
		idTypeOther: str(r.id_type_other),
		idNumber: str(r.id_number),
		idIssuedOn: str(r.id_issued_on),
		idIssuedBy: str(r.id_issued_by)
	};
}

export function toLease(r: Row, hasSignedContract = false): LeaseView {
	const status = (str(r.status) ?? 'draft') as LeaseStatus;
	return {
		id: String(r.id),
		unitId: String(r.unit_id ?? ''),
		tenantId: String(r.tenant_id ?? ''),
		startsOn: String(r.starts_on ?? ''),
		endsOn: str(r.ends_on),
		durationMonths: int(r.duration_months),
		duesStartOn: String(r.dues_start_on ?? r.starts_on ?? ''),
		rent: int(r.rent) ?? 0,
		charges: int(r.charges) ?? 0,
		periodicity: (str(r.periodicity) ?? 'monthly') as LeaseView['periodicity'],
		dueDay: int(r.due_day) ?? 5,
		billingMode: (str(r.billing_mode) ?? 'calendar_prorata') as LeaseView['billingMode'],
		advanceMonths: int(r.advance_months) ?? 0,
		lessorType: (str(r.lessor_type) ?? 'owner') as LeaseView['lessorType'],
		paymentTerms: str(r.payment_terms),
		penaltyRateBp: int(r.penalty_rate_bp),
		penaltyGraceDays: int(r.penalty_grace_days),
		penaltyBeneficiary: str(r.penalty_beneficiary) as LeaseView['penaltyBeneficiary'],
		noticeTenantFixedTermMonths: int(r.notice_tenant_fixed_term_months) ?? 2,
		noticeTenantOpenEndedMonths: int(r.notice_tenant_open_ended_months) ?? 3,
		noticeLessorFixedTermMonths: int(r.notice_lessor_fixed_term_months) ?? 3,
		noticeLessorOpenEndedMonths: int(r.notice_lessor_open_ended_months) ?? 3,
		reducedNoticeMonths: int(r.reduced_notice_months),
		reducedNoticeCases: str(r.reduced_notice_cases),
		earlyTerminationIndemnityMonths: int(r.early_termination_indemnity_months),
		renewalMode: (str(r.renewal_mode) ?? 'open_ended') as LeaseView['renewalMode'],
		depositRefundDays: int(r.deposit_refund_days) ?? 30,
		rentEffectiveFrom: String(r.rent_effective_from ?? r.dues_start_on ?? r.starts_on ?? ''),
		status,
		activatedOn: str(r.activated_on),
		cancelledAt: str(r.cancelled_at),
		cancellationReason: str(r.cancellation_reason),
		noticeGivenOn: str(r.notice_given_on),
		exitOn: str(r.exit_on),
		version: int(r.version) ?? 1,
		alerts: leaseAlerts({ status, hasSignedContract }),
		createdAt: str(r.created_at) ?? '',
		updatedAt: str(r.updated_at) ?? ''
	};
}

/**
 * Échéance : le statut affiché est celui du jour (même règle que la tâche de nuit, dont l'avance en retard seulement à
 * partir du début du bail quand la requête joint `lease_starts_on`), le solde se calcule.
 */
export function toRentDue(r: Row, today: string): RentDueView {
	const dueOn = String(r.due_on ?? '');
	const leaseStartsOn = str(r.lease_starts_on);
	const periodStart = String(r.period_start ?? '');
	const d = {
		dueOn,
		amountDue: int(r.amount_due) ?? 0,
		amountPaid: int(r.amount_paid) ?? 0,
		overdueFrom:
			leaseStartsOn && isIsoDate(dueOn) && isIsoDate(leaseStartsOn)
				? rentDueOverdueFrom({ dueOn, periodStart, isAdvance: bool(r.is_advance), prorated: bool(r.prorated) }, leaseStartsOn)
				: null
	};
	const stored = (str(r.status) ?? 'upcoming') as RentDueView['status'];
	return {
		id: String(r.id),
		leaseId: String(r.lease_id ?? ''),
		periodStart: String(r.period_start ?? ''),
		periodEnd: String(r.period_end ?? ''),
		dueOn: d.dueOn,
		rent: int(r.rent) ?? 0,
		charges: int(r.charges) ?? 0,
		amountDue: d.amountDue,
		amountPaid: d.amountPaid,
		balance: rentDueBalance(d),
		status: rentDueStatus({ ...d, waived: stored === 'waived' }, today),
		prorated: bool(r.prorated),
		isAdvance: bool(r.is_advance),
		leaseVersion: int(r.lease_version) ?? 1,
		// Lot 11 : la nature arrive sur l'appareil avec la synchronisation de `kind` (étape 4a) ; d'ici là, échéance ordinaire.
		kind: r.kind === 'opening_balance' ? 'opening_balance' : 'rent'
	};
}

export function toMovement(r: Row): DepositMovementView {
	return {
		id: String(r.id),
		accountId: String(r.account_id ?? ''),
		type: String(r.type) as DepositMovementView['type'],
		amount: int(r.amount) ?? 0,
		previousHolder: str(r.previous_holder) as DepositMovementView['previousHolder'],
		newHolder: str(r.new_holder) as DepositMovementView['newHolder'],
		reason: str(r.reason),
		occurredOn: String(r.occurred_on ?? ''),
		documentId: str(r.document_id),
		createdBy: str(r.created_by),
		createdAt: str(r.created_at) ?? ''
	};
}

/**
 * Compte de caution. Le statut et le détenteur sont ceux du serveur ; un mouvement encore en attente sur l'appareil
 * est déjà compté dans les soldes (il sera confirmé ou refusé à la synchronisation).
 */
export function toDepositAccount(r: Row, movements: DepositMovementView[], monthlyRent: number): DepositAccountView {
	const type = String(r.type) as DepositAccountView['type'];
	const agreedAmount = int(r.agreed_amount) ?? 0;
	const mine = movements.filter((m) => m.accountId === String(r.id));
	const changed = [...mine].reverse().find((m) => m.type === 'holder_changed');
	return {
		id: String(r.id),
		leaseId: String(r.lease_id ?? ''),
		type,
		agreedAmount,
		agreedMonths: int(r.agreed_months),
		holder: (changed?.newHolder ?? str(r.holder) ?? 'organization') as DepositAccountView['holder'],
		status: (str(r.status) ?? 'pending') as DepositAccountView['status'],
		balances: depositBalances(agreedAmount, mine),
		aboveLegalCap: depositAboveLegalCap(type, agreedAmount, monthlyRent),
		movements: mine
	};
}

export function toLeaseVersion(r: Row): LeaseVersionView {
	return {
		version: int(r.version) ?? 1,
		rent: int(r.rent) ?? 0,
		charges: int(r.charges) ?? 0,
		rentEffectiveFrom: String(r.rent_effective_from ?? ''),
		status: (str(r.status) ?? 'active') as LeaseStatus,
		changedBy: str(r.changed_by),
		recordedAt: str(r.recorded_at) ?? ''
	};
}

/** Occupation d'une unité, calculée sur l'appareil à partir des signaux de ses baux (colonne `lease_signals`). */
export function occupancyFromSignals(json: unknown, today: string): Occupancy {
	let list: { status: string; starts_on: string }[] = [];
	if (typeof json === 'string' && json) {
		try {
			const parsed = JSON.parse(json) as unknown;
			if (Array.isArray(parsed)) list = parsed as typeof list;
		} catch {
			list = [];
		}
	}
	return unitOccupancy(
		list.map((l) => ({ status: l.status as LeaseStatus, startsOn: String(l.starts_on) })),
		today
	);
}

/**
 * Aperçu de l'échéancier, par la même fonction pure que le serveur : bail pas encore validé par le serveur (brouillon,
 * ou validé hors ligne et en attente). La date de signature est celle du jour.
 */
export function previewSchedule(lease: LeaseView, today: string): RentDueDraft[] {
	const activatedOn = lease.activatedOn ?? today;
	try {
		return generateRentSchedule({
			billingMode: lease.billingMode,
			periodicity: lease.periodicity,
			startOn: lease.startsOn,
			endOn: lease.endsOn,
			duesStartOn: lease.duesStartOn,
			dueDay: lease.dueDay,
			advanceMonths: lease.advanceMonths,
			activatedOn,
			rates: [{ effectiveFrom: lease.duesStartOn, rent: lease.rent, charges: lease.charges, version: 1 }],
			until: scheduleUntil({ endOn: lease.endsOn, duesStartOn: lease.duesStartOn }, today)
		});
	} catch {
		return [];
	}
}

/** Recherche sur le nom (sans accents) et sur les chiffres du téléphone ; une recherche vide garde tout. */
export function searchTenants<T extends Pick<TenantView, 'fullName' | 'phone'>>(tenants: T[], query: string): T[] {
	const q = normalize(query);
	if (!q) return tenants;
	const digits = q.replace(/\D/g, '');
	return tenants.filter(
		(t) => normalize(t.fullName).includes(q) || (digits.length >= 2 && (t.phone ?? '').replace(/\D/g, '').includes(digits))
	);
}

export type TimelineKind = 'created' | 'validated' | 'rent_change' | 'deposit' | 'holder' | 'document' | 'cancelled';

export interface TimelineEvent {
	date: string;
	kind: TimelineKind;
	/** Données de l'événement (montant, version, nom du fichier…), mises en forme par l'écran. */
	detail: Record<string, string | number | null>;
}

/** Chronologie du bail (docs/UX.md §10) : création, validation, versions, mouvements de caution, documents. */
export function leaseTimeline(
	lease: LeaseView,
	versions: LeaseVersionView[],
	movements: DepositMovementView[],
	documents: { fileName: string; type: string; createdAt: string; status: string }[]
): TimelineEvent[] {
	const events: TimelineEvent[] = [];
	if (lease.createdAt) events.push({ date: lease.createdAt.slice(0, 10), kind: 'created', detail: {} });
	if (lease.activatedOn) events.push({ date: lease.activatedOn, kind: 'validated', detail: { status: lease.status } });
	for (const v of versions.filter((x) => x.version > 1)) {
		events.push({
			date: v.recordedAt.slice(0, 10),
			kind: 'rent_change',
			detail: { rent: v.rent, charges: v.charges, from: v.rentEffectiveFrom, version: v.version }
		});
	}
	for (const m of movements) {
		if (m.type === 'holder_changed') events.push({ date: m.occurredOn, kind: 'holder', detail: { holder: m.newHolder, reason: m.reason } });
		else events.push({ date: m.occurredOn, kind: 'deposit', detail: { type: m.type, amount: m.amount } });
	}
	for (const d of documents)
		events.push({ date: d.createdAt.slice(0, 10), kind: 'document', detail: { fileName: d.fileName, type: d.type, status: d.status } });
	if (lease.cancelledAt)
		events.push({ date: lease.cancelledAt.slice(0, 10), kind: 'cancelled', detail: { reason: lease.cancellationReason } });
	return events.filter((e) => e.date).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
