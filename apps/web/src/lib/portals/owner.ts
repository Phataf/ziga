/**
 * Espace du propriétaire (lot 10 ter, étape 3b) : vues des réponses de `/me/portal/owner/*`, lues en ligne (ces espaces ne
 * sont pas synchronisés hors ligne). Fonctions pures, testées ; les écrans ne font qu'afficher.
 */
import type { IncomeMonth, IncomeProperty } from '@ziga/shared/portals';

export interface OwnerUnit {
	id: string;
	label: string;
	type: string;
	rent: number | null;
	charges: number | null;
	occupancy: 'free' | 'reserved' | 'occupied' | 'notice';
	technicalStatus: string;
	available: boolean;
	lease: {
		id: string;
		status: string;
		startsOn: string;
		endsOn: string | null;
		rent: number;
		charges: number;
		tenant: { fullName: string; civility: string | null };
		deposit: { agreedAmount: number; holder: string; holderName: string | null } | null;
	} | null;
}

export interface OwnerAssetsOrganization {
	organizationId: string;
	organizationName: string;
	organizationType: 'agency' | 'landlord';
	organizationPhone: string;
	managedBy: 'agency' | 'self';
	properties: { id: string; name: string; type: string; units: OwnerUnit[] }[];
}

export interface OwnerStatement {
	organizationId: string;
	organizationName: string;
	id: string;
	month: string;
	version: number;
	issuedOn: string | null;
	collected: number;
	commission: number;
	expenses: number;
	net: number;
	paidOut: number;
	remaining: number;
	pdfAvailable: boolean;
	payouts: { id: string; kind: string; amount: number; paidOn: string; method: string }[];
}

export type UnitSituation = 'available' | 'occupied' | 'notice' | 'reserved' | 'unavailable';

/** Situation d'une unité pour son propriétaire : la disponibilité suit la règle 13 (calculée par le serveur). */
export function unitSituation(u: Pick<OwnerUnit, 'occupancy' | 'available'>): UnitSituation {
	if (u.occupancy === 'occupied') return 'occupied';
	if (u.occupancy === 'notice') return 'notice';
	if (u.occupancy === 'reserved') return 'reserved';
	return u.available ? 'available' : 'unavailable';
}

/** Totaux du patrimoine : biens, unités, unités louées (occupées ou en préavis). */
export function assetTotals(orgs: readonly OwnerAssetsOrganization[]): { properties: number; units: number; let: number } {
	const units = orgs.flatMap((o) => o.properties.flatMap((p) => p.units));
	return {
		properties: orgs.reduce((n, o) => n + o.properties.length, 0),
		units: units.length,
		let: units.filter((u) => u.occupancy === 'occupied' || u.occupancy === 'notice').length
	};
}

/** Revenus par mois, toutes organisations confondues (la plus récente d'abord). */
export function incomeByMonth(months: readonly IncomeMonth[]): Omit<IncomeMonth, 'organizationId'>[] {
	const byMonth = new Map<string, Omit<IncomeMonth, 'organizationId'>>();
	for (const m of months) {
		const row = byMonth.get(m.month) ?? { month: m.month, collected: 0, commission: 0, expenses: 0, net: 0, paidOut: 0 };
		row.collected += m.collected;
		row.commission += m.commission;
		row.expenses += m.expenses;
		row.net += m.net;
		row.paidOut += m.paidOut;
		byMonth.set(m.month, row);
	}
	return [...byMonth.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
}

/** Nom d'un bien à partir du patrimoine (pour les revenus par bien). */
export function propertyNames(orgs: readonly OwnerAssetsOrganization[]): Map<string, string> {
	return new Map(orgs.flatMap((o) => o.properties.map((p) => [p.id, p.name] as const)));
}

/** Revenus par bien, le meilleur rendement d'abord (sans rendement : à la fin). */
export function propertiesByYield(rows: readonly IncomeProperty[]): IncomeProperty[] {
	return [...rows].sort(
		(a, b) => (b.yieldPercent ?? -Infinity) - (a.yieldPercent ?? -Infinity) || a.propertyId.localeCompare(b.propertyId)
	);
}

/** Reversements de tous les relevés, du plus récent au plus ancien ; une contre-écriture est négative. */
export function payoutsOf(statements: readonly OwnerStatement[]) {
	return statements
		.flatMap((s) =>
			s.payouts.map((p) => ({
				...p,
				signedAmount: p.kind === 'reversal' ? -p.amount : p.amount,
				month: s.month,
				statementId: s.id,
				organizationId: s.organizationId,
				organizationName: s.organizationName
			}))
		)
		.sort((a, b) => (a.paidOn === b.paidOn ? (a.id < b.id ? 1 : -1) : a.paidOn < b.paidOn ? 1 : -1));
}

/** Rendement affiché « 87,5 % » (espace fine insécable avant le signe). */
export function formatYield(percent: number): string {
	return `${percent.toLocaleString('fr-FR', { maximumFractionDigits: 2 })}\u202f%`;
}
