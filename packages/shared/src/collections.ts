/**
 * Impayés (lot 10, module `collections`) en fonctions pures : la même vue sur l'appareil (lecture locale) et dans l'API.
 *
 * - Échéances en retard (`overdue`) ou payées en partie et exigibles (`partial`), et dépenses réclamées au locataire
 *   (option A du porteur : la dépense est la créance, jamais copiée), groupées par locataire, triées par ancienneté.
 * - **Une échéance couverte par un encaissement à valider ou à rapprocher n'est ni proposée ni relancée** (note du
 *   lot 09) : ces encaissements ne sont imputés qu'à la confirmation, on les place donc par l'imputation
 *   prévisionnelle du lot 09 (`forecastRentAllocation`), et toute échéance qu'elle touche est marquée.
 * - Suggestion de relance à J+5, J+15 puis J+30 (seuils de l'organisation) ; jamais d'envoi automatique.
 */
import { forecastRentAllocation, type DueForAllocation } from './allocation.js';
import { addDays, daysBetween, toIsoDate } from './dates.js';
import { expenseClaimBalance, type ExpenseCategory } from './expenses.js';
import { rentDueBalance, rentDueStatus } from './leases.js';
import type { Fcfa } from './money.js';
import { DEFAULT_REMINDER_OFFSETS, type ReminderChannel, type ReminderLevel } from './reminders.js';

export const ARREARS_BUCKETS = ['1_7', '8_30', 'over_30'] as const;
export type ArrearsBucket = (typeof ARREARS_BUCKETS)[number];

/** Tranche de retard : 1 à 7 jours, 8 à 30, plus de 30. */
export function arrearsBucket(daysLate: number): ArrearsBucket | null {
	if (daysLate <= 0) return null;
	if (daysLate <= 7) return '1_7';
	if (daysLate <= 30) return '8_30';
	return 'over_30';
}

export interface ArrearsDueInput extends DueForAllocation {
	leaseId: string;
	tenantId: string;
	unitId: string;
	periodStart: string;
	periodEnd: string;
	overdueFrom?: string | null;
}

export interface ArrearsClaimInput {
	expenseId: string;
	leaseId: string;
	tenantId: string;
	unitId: string | null;
	/** Date de la dépense : la créance est exigible dès ce jour, en retard le lendemain. */
	date: string;
	category: ExpenseCategory;
	description: string;
	amount: Fcfa;
	/** Imputations nettes des encaissements « dépense » confirmés. */
	recovered: Fcfa;
	cancelled: boolean;
}

export interface ArrearsInput {
	today: string;
	/** Toutes les échéances des baux concernés (y compris à venir) : l'imputation prévisionnelle en a besoin. */
	dues: readonly ArrearsDueInput[];
	claims?: readonly ArrearsClaimInput[];
	tenants: readonly { id: string; name: string; phone: string | null }[];
	/** Encaissements de loyer à valider ou à rapprocher, par bail. */
	pendingRentPayments?: readonly { leaseId: string; amount: Fcfa }[];
	/** Encaissements « dépense » à valider ou à rapprocher. */
	pendingClaimPayments?: readonly { expenseId: string; amount: Fcfa }[];
	reminders?: readonly { tenantId: string; sentAt: string; channel: ReminderChannel }[];
	offsets?: readonly [number, number, number];
	/** Filtres : quartier, propriétaire, agent (par unité), tranche de retard. */
	filter?: ArrearsFilter;
	units?: ReadonlyMap<string, ArrearsUnitContext>;
	/** « Ma tournée » : inclure aussi les échéances dues aujourd'hui. */
	includeDueToday?: boolean;
}

export interface ArrearsUnitContext {
	neighborhoodId: string | null;
	ownerId: string | null;
	agentIds: readonly string[];
}

export interface ArrearsFilter {
	neighborhoodId?: string | null;
	ownerId?: string | null;
	agentId?: string | null;
	bucket?: ArrearsBucket | null;
}

export interface ArrearsItem {
	kind: 'rent_due' | 'expense_claim';
	/** Échéance ou dépense. */
	id: string;
	leaseId: string;
	unitId: string | null;
	dueOn: string;
	periodStart: string | null;
	periodEnd: string | null;
	category: ExpenseCategory | null;
	description: string | null;
	balance: Fcfa;
	daysLate: number;
	status: 'overdue' | 'partial' | 'due';
	/** Couverte par un encaissement à valider ou à rapprocher : ni proposée ni relancée. */
	awaitingValidation: boolean;
}

export interface ArrearsGroup {
	tenantId: string;
	tenantName: string;
	phone: string | null;
	items: ArrearsItem[];
	total: Fcfa;
	/** Ce qu'une relance peut demander (hors encaissements en attente). */
	remindable: Fcfa;
	remindableItems: ArrearsItem[];
	oldestDueOn: string;
	daysLate: number;
	bucket: ArrearsBucket | null;
	awaitingValidation: boolean;
	lastReminder: { sentAt: string; channel: ReminderChannel } | null;
	suggestion: { level: ReminderLevel; thresholdDays: number } | null;
}

function daysLateFrom(lateFrom: string, today: string): number {
	return today >= lateFrom ? daysBetween(lateFrom, today) + 1 : 0;
}

/** Échéances touchées par l'imputation prévisionnelle des encaissements en attente d'un bail. */
function awaitingDueIds(dues: readonly ArrearsDueInput[], pending: readonly { leaseId: string; amount: Fcfa }[]): Set<string> {
	const out = new Set<string>();
	const byLease = new Map<string, Fcfa>();
	for (const p of pending) byLease.set(p.leaseId, (byLease.get(p.leaseId) ?? 0) + p.amount);
	for (const [leaseId, amount] of byLease) {
		if (amount <= 0) continue;
		const { lines } = forecastRentAllocation(
			amount,
			dues.filter((d) => d.leaseId === leaseId)
		);
		for (const l of lines) if (l.target === 'rent_due' && l.targetId) out.add(l.targetId);
	}
	return out;
}

/**
 * Suggestion de relance : le niveau est le nombre de seuils franchis par le plus ancien retard relançable ; rien n'est
 * proposé si une relance (tout canal) a été faite depuis le dernier seuil franchi.
 */
export function reminderSuggestion(
	daysLate: number,
	today: string,
	lastReminderOn: string | null,
	offsets: readonly [number, number, number] = DEFAULT_REMINDER_OFFSETS
): { level: ReminderLevel; thresholdDays: number } | null {
	const level = offsets.filter((o) => daysLate >= o).length;
	if (level === 0) return null;
	const threshold = offsets[level - 1]!;
	const crossedOn = addDays(today, threshold - daysLate);
	if (lastReminderOn !== null && lastReminderOn >= crossedOn) return null;
	return { level: level as ReminderLevel, thresholdDays: threshold };
}

/** Vue des impayés, groupés par locataire, du plus ancien retard au plus récent. */
export function arrearsGroups(input: ArrearsInput): ArrearsGroup[] {
	const { today } = input;
	const awaiting = awaitingDueIds(input.dues, input.pendingRentPayments ?? []);
	const pendingClaims = new Set((input.pendingClaimPayments ?? []).filter((p) => p.amount > 0).map((p) => p.expenseId));
	const items = new Map<string, ArrearsItem[]>();
	const push = (tenantId: string, item: ArrearsItem) => items.set(tenantId, [...(items.get(tenantId) ?? []), item]);
	const unitMatches = (unitId: string | null) => {
		const f = input.filter;
		if (!f || (!f.neighborhoodId && !f.ownerId && !f.agentId)) return true;
		const ctx = unitId ? input.units?.get(unitId) : undefined;
		if (!ctx) return false;
		return (
			(!f.neighborhoodId || ctx.neighborhoodId === f.neighborhoodId) &&
			(!f.ownerId || ctx.ownerId === f.ownerId) &&
			(!f.agentId || ctx.agentIds.includes(f.agentId))
		);
	};

	for (const d of input.dues) {
		const status = rentDueStatus(d, today);
		const exigible = status === 'overdue' || (status === 'partial' && d.dueOn <= today) || (input.includeDueToday && status === 'due');
		if (!exigible || !unitMatches(d.unitId)) continue;
		push(d.tenantId, {
			kind: 'rent_due',
			id: d.id,
			leaseId: d.leaseId,
			unitId: d.unitId,
			dueOn: d.dueOn,
			periodStart: d.periodStart,
			periodEnd: d.periodEnd,
			category: null,
			description: null,
			balance: rentDueBalance(d),
			daysLate: status === 'overdue' ? daysLateFrom(d.overdueFrom ?? addDays(d.dueOn, 1), today) : 0,
			status: status === 'overdue' ? 'overdue' : status === 'partial' ? 'partial' : 'due',
			awaitingValidation: awaiting.has(d.id)
		});
	}
	for (const c of input.claims ?? []) {
		const balance = expenseClaimBalance(c);
		if (balance === 0 || c.date > today || !unitMatches(c.unitId)) continue;
		const daysLate = daysLateFrom(addDays(c.date, 1), today);
		push(c.tenantId, {
			kind: 'expense_claim',
			id: c.expenseId,
			leaseId: c.leaseId,
			unitId: c.unitId,
			dueOn: c.date,
			periodStart: null,
			periodEnd: null,
			category: c.category,
			description: c.description,
			balance,
			daysLate,
			status: daysLate > 0 ? 'overdue' : c.recovered > 0 ? 'partial' : 'due',
			awaitingValidation: pendingClaims.has(c.expenseId)
		});
	}

	const tenants = new Map(input.tenants.map((t) => [t.id, t]));
	const lastReminder = new Map<string, { sentAt: string; channel: ReminderChannel }>();
	for (const r of input.reminders ?? []) {
		const cur = lastReminder.get(r.tenantId);
		if (!cur || r.sentAt > cur.sentAt) lastReminder.set(r.tenantId, { sentAt: r.sentAt, channel: r.channel });
	}

	const groups: ArrearsGroup[] = [];
	for (const [tenantId, list] of items) {
		list.sort((a, b) => (a.dueOn !== b.dueOn ? (a.dueOn < b.dueOn ? -1 : 1) : a.id < b.id ? -1 : 1));
		const remindableItems = list.filter((i) => !i.awaitingValidation);
		const daysLate = Math.max(0, ...list.map((i) => i.daysLate));
		const remindableLate = Math.max(0, ...remindableItems.map((i) => i.daysLate));
		const last = lastReminder.get(tenantId) ?? null;
		const tenant = tenants.get(tenantId);
		const group: ArrearsGroup = {
			tenantId,
			tenantName: tenant?.name ?? '',
			phone: tenant?.phone ?? null,
			items: list,
			total: list.reduce((s, i) => s + i.balance, 0),
			remindable: remindableItems.reduce((s, i) => s + i.balance, 0),
			remindableItems,
			oldestDueOn: list[0]!.dueOn,
			daysLate,
			bucket: arrearsBucket(daysLate),
			awaitingValidation: list.some((i) => i.awaitingValidation),
			lastReminder: last,
			suggestion: remindableItems.length
				? reminderSuggestion(remindableLate, today, last ? toIsoDate(new Date(last.sentAt)) : null, input.offsets)
				: null
		};
		if (input.filter?.bucket && group.bucket !== input.filter.bucket) continue;
		groups.push(group);
	}
	return groups.sort((a, b) =>
		a.daysLate !== b.daysLate
			? b.daysLate - a.daysLate
			: a.total !== b.total
				? b.total - a.total
				: a.tenantName.localeCompare(b.tenantName, 'fr')
	);
}

/** Une relance n'est possible que s'il reste quelque chose à demander et un numéro de téléphone. */
export function canRemind(group: Pick<ArrearsGroup, 'remindable' | 'phone'>): boolean {
	return group.remindable > 0 && !!group.phone;
}
