/**
 * Tableau de bord d'accueil (lot 10, docs/UX.md §4) : indicateurs calculés sur l'appareil, à partir des tables
 * synchronisées, sans appel réseau. Fonctions pures, les mêmes pour chaque profil ; l'écran choisit ce qu'il montre.
 */
import { rentDueBalance, rentDueStatus, type RentDueForStatus } from './leases.js';
import type { Fcfa } from './money.js';
import { monthEnd, monthOfDate, monthStart } from './statements.js';

export interface DashboardDue extends RentDueForStatus {
	id: string;
	waived?: boolean;
}

export interface DashboardPayment {
	/** Encaissement de loyer confirmé, non annulé. */
	amount: Fcfa;
	paidOn: string;
}

export interface DashboardSummary {
	month: string;
	/** Loyers et charges des échéances du mois. */
	expected: Fcfa;
	/** Ce qui a été payé sur ces échéances. */
	paidOnExpected: Fcfa;
	/** Encaissements confirmés du mois, par date de paiement (avances et retards compris). */
	collected: Fcfa;
	/** Taux d'encaissement des échéances du mois, en pourcentage entier (arrondi à l'inférieur). */
	collectionRate: number | null;
	/** Reste dû sur les échéances en retard ou payées en partie. */
	arrears: Fcfa;
	arrearsCount: number;
	/** Échéances du jour non soldées. */
	dueToday: DashboardDue[];
	statementsToIssue: number;
}

export function dashboardSummary(input: {
	today: string;
	dues: readonly DashboardDue[];
	confirmedRentPayments: readonly DashboardPayment[];
	statementsToIssue?: number;
}): DashboardSummary {
	const month = monthOfDate(input.today);
	const start = monthStart(month);
	const end = monthEnd(month);
	let expected = 0;
	let paidOnExpected = 0;
	let arrears = 0;
	let arrearsCount = 0;
	const dueToday: DashboardDue[] = [];
	for (const d of input.dues) {
		if (d.waived) continue;
		if (d.dueOn >= start && d.dueOn <= end) {
			expected += d.amountDue;
			paidOnExpected += Math.min(d.amountPaid, d.amountDue);
		}
		const status = rentDueStatus(d, input.today);
		if (status === 'overdue' || (status === 'partial' && d.dueOn <= input.today)) {
			arrears += rentDueBalance(d);
			arrearsCount += 1;
		}
		if (d.dueOn === input.today && status !== 'paid') dueToday.push(d);
	}
	const collected = input.confirmedRentPayments.filter((p) => p.paidOn >= start && p.paidOn <= end).reduce((s, p) => s + p.amount, 0);
	return {
		month,
		expected,
		paidOnExpected,
		collected,
		collectionRate: expected === 0 ? null : Math.floor((paidOnExpected * 100) / expected),
		arrears,
		arrearsCount,
		dueToday,
		statementsToIssue: input.statementsToIssue ?? 0
	};
}
