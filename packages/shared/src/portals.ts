/**
 * Espaces personnels (lot 10 ter) : règles pures de l'espace du propriétaire.
 *
 * Revenus, à partir des relevés émis de chaque organisation (jamais un brouillon) :
 * - par mois et par organisation : encaissé, commission, dépenses (signées, négatives si déduites), net, reversé ;
 * - par bien, sur les 12 derniers mois : encaissé, net, rendement simple = net ÷ encaissé (réponse du porteur, le
 *   registre ne connaît ni le prix ni la valeur d'un bien).
 * Un relevé calcule la commission par mandat, pas par unité : elle est répartie entre les biens du relevé au prorata
 * de leur encaissé, en francs entiers (le dernier bien reçoit le reste, pour que la somme soit exacte). Une dépense
 * rattachée à une unité reste sur son bien ; une dépense sans unité est répartie comme la commission. Le report d'un
 * solde négatif reste au niveau du relevé.
 */
import { addMonthsToMonth, type StatementMonth } from './statements.js';

export interface IncomeStatement {
	organizationId: string;
	id: string;
	month: StatementMonth;
	collected: number;
	commission: number;
	expenses: number;
	net: number;
	paidOut: number;
	unitTotals: readonly { unitId: string; total: number }[];
	expenseLines: readonly { unitId: string | null; amount: number }[];
}

export interface IncomeMonth {
	organizationId: string;
	month: StatementMonth;
	collected: number;
	commission: number;
	expenses: number;
	net: number;
	paidOut: number;
}

export interface IncomeProperty {
	organizationId: string;
	propertyId: string;
	collected: number;
	net: number;
	/** Net ÷ encaissé, en pour cent, deux décimales ; null sans encaissement. */
	yieldPercent: number | null;
}

/** Répartit `amount` (entier) au prorata des poids, en entiers : le dernier poids non nul reçoit le reste. */
export function prorateFcfa(amount: number, weights: readonly number[]): number[] {
	const total = weights.reduce((a, b) => a + b, 0);
	if (total <= 0) return weights.map(() => 0);
	const shares = weights.map((w) => Math.trunc((amount * w) / total));
	const last = weights.map((w) => w > 0).lastIndexOf(true);
	shares[last]! += amount - shares.reduce((a, b) => a + b, 0);
	return shares;
}

export function yieldPercent(net: number, collected: number): number | null {
	return collected > 0 ? Math.round((net / collected) * 10_000) / 100 : null;
}

/** Revenus du propriétaire, par mois et par bien (12 derniers mois jusqu'à `currentMonth` compris). */
export function ownerIncome(
	statements: readonly IncomeStatement[],
	unitProperty: ReadonlyMap<string, string>,
	currentMonth: StatementMonth
): { months: IncomeMonth[]; properties: IncomeProperty[] } {
	const months = new Map<string, IncomeMonth>();
	for (const s of statements) {
		const key = `${s.organizationId}|${s.month}`;
		const m = months.get(key) ?? {
			organizationId: s.organizationId,
			month: s.month,
			collected: 0,
			commission: 0,
			expenses: 0,
			net: 0,
			paidOut: 0
		};
		m.collected += s.collected;
		m.commission += s.commission;
		m.expenses += s.expenses;
		m.net += s.net;
		m.paidOut += s.paidOut;
		months.set(key, m);
	}

	const since = addMonthsToMonth(currentMonth, -11);
	const byProperty = new Map<string, IncomeProperty>();
	for (const s of statements.filter((x) => x.month >= since && x.month <= currentMonth)) {
		const collectedBy = new Map<string, number>();
		for (const u of s.unitTotals) {
			const p = unitProperty.get(u.unitId);
			if (p) collectedBy.set(p, (collectedBy.get(p) ?? 0) + u.total);
		}
		const expensesBy = new Map<string, number>();
		let unattributed = 0;
		for (const e of s.expenseLines) {
			const p = e.unitId ? unitProperty.get(e.unitId) : undefined;
			if (p) expensesBy.set(p, (expensesBy.get(p) ?? 0) + e.amount);
			else unattributed += e.amount;
		}
		const properties = [...new Set([...collectedBy.keys(), ...expensesBy.keys()])].sort();
		const weights = properties.map((p) => collectedBy.get(p) ?? 0);
		const commission = prorateFcfa(s.commission, weights);
		const shared = prorateFcfa(unattributed, weights);
		properties.forEach((p, i) => {
			const key = `${s.organizationId}|${p}`;
			const row = byProperty.get(key) ?? { organizationId: s.organizationId, propertyId: p, collected: 0, net: 0, yieldPercent: null };
			const collected = collectedBy.get(p) ?? 0;
			row.collected += collected;
			row.net += collected - commission[i]! + (expensesBy.get(p) ?? 0) + shared[i]!;
			byProperty.set(key, row);
		});
	}
	for (const row of byProperty.values()) row.yieldPercent = yieldPercent(row.net, row.collected);

	return {
		months: [...months.values()].sort((a, b) =>
			a.month === b.month ? a.organizationId.localeCompare(b.organizationId) : a.month < b.month ? 1 : -1
		),
		properties: [...byProperty.values()].sort(
			(a, b) => a.organizationId.localeCompare(b.organizationId) || a.propertyId.localeCompare(b.propertyId)
		)
	};
}
