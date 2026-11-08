/**
 * Règles métier pures de la maquette (sans état, sans interface).
 * Elles préfigurent ce qui vivra dans packages/shared.
 */
import { daysBetween } from './format';
import { dimensionsOf, technicalLabel } from './unit-status';
import type { Allocation, Mandate, Payment, PaymentMethod, RentDue, Unit } from './types';

export interface DueState extends RentDue {
	paid: number;
	balance: number;
}

/** Montant déjà imputé sur chaque échéance. */
export function paidByDue(payments: Payment[]): Map<string, number> {
	const map = new Map<string, number>();
	for (const p of payments) {
		for (const a of p.allocations) {
			map.set(a.rentDueId, (map.get(a.rentDueId) ?? 0) + a.amount);
		}
	}
	return map;
}

/** Échéances avec ce qui a été payé et ce qui reste, de la plus ancienne à la plus récente. */
export function dueStates(dues: RentDue[], payments: Payment[]): DueState[] {
	const paid = paidByDue(payments);
	return [...dues]
		.sort((a, b) => a.dueDate.localeCompare(b.dueDate))
		.map((d) => {
			const p = paid.get(d.id) ?? 0;
			return { ...d, paid: p, balance: Math.max(0, d.amount - p) };
		});
}

/**
 * Impute un paiement sur les échéances ouvertes, la plus ancienne d'abord (cadrage §5).
 * La somme des imputations ne dépasse jamais le montant payé ; l'excédent reste en avance.
 */
export function allocateOldestFirst(
	amount: number,
	openDues: Pick<DueState, 'id' | 'period' | 'dueDate' | 'balance'>[]
): { allocations: Allocation[]; advance: number } {
	if (!Number.isSafeInteger(amount) || amount <= 0) {
		throw new RangeError('Le montant doit être un entier positif.');
	}
	let rest = amount;
	const allocations: Allocation[] = [];
	const sorted = [...openDues].filter((d) => d.balance > 0).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
	for (const due of sorted) {
		if (rest === 0) break;
		const part = Math.min(rest, due.balance);
		allocations.push({ rentDueId: due.id, period: due.period, amount: part });
		rest -= part;
	}
	return { allocations, advance: rest };
}

/**
 * Un Mobile Money déclaré à la main reste « à rapprocher » ; les espèces saisies par un agent de terrain
 * restent « à valider » ; celles saisies par un gestionnaire sont validées.
 */
export function initialStatus(method: PaymentMethod, enteredByFieldAgent = false): Payment['status'] {
	if (method === 'orange_money' || method === 'moov_money') return 'to_reconcile';
	return enteredByFieldAgent ? 'to_validate' : 'validated';
}

export function isMandateActive(mandate: Mandate, today: string): boolean {
	return mandate.startDate <= today && today <= mandate.endDate;
}

/**
 * Enregistrer n'est jamais publier (CLAUDE.md §5.7) : renvoie les conditions non remplies.
 * L'unité doit être disponible (règle 13) : fiche active, libre ou en préavis, et prête.
 */
export function publicationBlockers(unit: Unit, mandate: Mandate, today: string): string[] {
	const reasons: string[] = [];
	const d = dimensionsOf(unit);
	if (d.record !== 'active') reasons.push('La fiche de l’unité n’est pas active.');
	if (d.occupancy === 'occupied') reasons.push('L’unité est louée.');
	else if (d.occupancy === 'reserved') reasons.push('L’unité n’est pas libre.');
	if (d.technical !== 'ready') reasons.push(`L’unité n’est pas prête (${technicalLabel[d.technical].toLowerCase()}).`);
	if (!mandate.selfManaged && !isMandateActive(mandate, today)) reasons.push('Le mandat n’est pas actif.');
	else if (!mandate.selfManaged && !mandate.canPublish) reasons.push('Le mandat n’autorise pas la publication.');
	if (unit.photos < 3) reasons.push(`Il faut au moins 3 photos (${unit.photos} actuellement).`);
	if (!(unit.rent > 0)) reasons.push('Le loyer n’est pas renseigné.');
	return reasons;
}

/** Jours de retard d'une échéance non soldée (0 si elle n'est pas échue). */
export function lateDays(due: Pick<RentDue, 'dueDate'>, today: string): number {
	return Math.max(0, daysBetween(due.dueDate, today));
}

export interface StatementLine {
	paymentId: string;
	date: string;
	label: string;
	amount: number;
	commission: number;
}

export interface StatementTotals {
	received: number;
	commission: number;
	expenses: number;
	net: number;
}

/** Commission arrondie au franc (entier FCFA, jamais de flottant stocké). */
export function commissionOf(amount: number, ratePercent: number): number {
	return Math.round((amount * ratePercent) / 100);
}

export function statementTotals(lines: Pick<StatementLine, 'amount' | 'commission'>[], expenses: { amount: number }[]): StatementTotals {
	const received = lines.reduce((s, l) => s + l.amount, 0);
	const commission = lines.reduce((s, l) => s + l.commission, 0);
	const exp = expenses.reduce((s, e) => s + e.amount, 0);
	return { received, commission, expenses: exp, net: received - commission - exp };
}
