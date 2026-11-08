/**
 * Vues calculées sur le jeu de données (fonctions pures, testables sans navigateur).
 */
import { daysBetween } from './format';
import { commissionOf, dueStates, lateDays, statementTotals, type DueState, type StatementLine } from './rules';
import { isLeaseCurrent, isLeaseEnded } from './unit-status';
import type { Dataset, Expense, Lease, Owner, Payment, Property, Tenant, Unit } from './types';

export interface LeaseView {
	lease: Lease;
	tenant: Tenant;
	unit: Unit;
	property: Property;
	owner: Owner;
	dues: DueState[];
	/** Échéances échues (date ≤ aujourd'hui) non soldées. */
	openDues: DueState[];
	/** Solde exigible aujourd'hui. */
	balanceDue: number;
	/** Échéances échues strictement avant aujourd'hui et non soldées. */
	overdueDues: DueState[];
	overdueAmount: number;
	/** Retard de la plus ancienne échéance impayée, en jours. */
	maxLateDays: number;
	dueToday: DueState | undefined;
	nextDue: DueState | undefined;
	payments: Payment[];
}

export function leaseView(data: Dataset, leaseId: string): LeaseView | undefined {
	const lease = data.leases.find((l) => l.id === leaseId);
	if (!lease) return undefined;
	const tenant = data.tenants.find((t) => t.id === lease.tenantId)!;
	const unit = data.units.find((u) => u.id === lease.unitId)!;
	const property = data.properties.find((p) => p.id === unit.propertyId)!;
	const owner = data.owners.find((o) => o.id === property.ownerId)!;
	const payments = data.payments.filter((p) => p.leaseId === lease.id);
	const dues = dueStates(
		data.dues.filter((d) => d.leaseId === lease.id),
		payments
	);
	const openDues = dues.filter((d) => d.balance > 0 && d.dueDate <= data.today);
	const overdueDues = openDues.filter((d) => d.dueDate < data.today);
	return {
		lease,
		tenant,
		unit,
		property,
		owner,
		dues,
		openDues,
		balanceDue: openDues.reduce((s, d) => s + d.balance, 0),
		overdueDues,
		overdueAmount: overdueDues.reduce((s, d) => s + d.balance, 0),
		maxLateDays: overdueDues.length ? lateDays(overdueDues[0], data.today) : 0,
		dueToday: openDues.find((d) => d.dueDate === data.today),
		nextDue: dues.find((d) => d.balance > 0 && d.dueDate > data.today),
		payments: [...payments].sort((a, b) => b.date.localeCompare(a.date))
	};
}

/** Baux en cours (les baux terminés restent consultables, mais ne sont plus à encaisser ni à relancer). */
export function allLeaseViews(data: Dataset): LeaseView[] {
	return data.leases.filter((l) => !isLeaseEnded(l, data.today)).map((l) => leaseView(data, l.id)!);
}

/** Locataires à encaisser : d'abord ceux qui doivent, du plus gros solde au plus petit. */
export function collectList(data: Dataset): LeaseView[] {
	return allLeaseViews(data).sort((a, b) => {
		if (a.balanceDue !== b.balanceDue) return b.balanceDue - a.balanceDue;
		return a.tenant.name.localeCompare(b.tenant.name, 'fr');
	});
}

/** Impayés triés par retard décroissant. */
export function arrears(data: Dataset): LeaseView[] {
	return allLeaseViews(data)
		.filter((v) => v.overdueAmount > 0)
		.sort((a, b) => b.maxLateDays - a.maxLateDays || b.overdueAmount - a.overdueAmount);
}

export function currentPeriod(data: Dataset): string {
	return data.today.slice(0, 7);
}

export function monthStats(data: Dataset) {
	const period = currentPeriod(data);
	const expected = data.dues.filter((d) => d.period === period).reduce((s, d) => s + d.amount, 0);
	const collected = data.payments.filter((p) => p.date.startsWith(period)).reduce((s, p) => s + p.amount, 0);
	const late = arrears(data);
	return {
		period,
		expected,
		collected,
		arrearsCount: late.length,
		arrearsAmount: late.reduce((s, v) => s + v.overdueAmount, 0),
		dueToday: allLeaseViews(data).filter((v) => v.dueToday)
	};
}

export function paymentsOfMonth(data: Dataset, period = currentPeriod(data)): Payment[] {
	return data.payments
		.filter((p) => p.date.startsWith(period))
		.sort((a, b) => b.date.localeCompare(a.date) || b.receiptNumber.localeCompare(a.receiptNumber));
}

export function propertyUnits(data: Dataset, propertyId: string): Unit[] {
	return data.units.filter((u) => u.propertyId === propertyId);
}

/** Bail en cours d'une unité (un seul par unité, règle 8). */
export function activeLeaseOfUnit(data: Dataset, unitId: string): Lease | undefined {
	return data.leases.find((l) => l.unitId === unitId && isLeaseCurrent(l, data.today));
}

export interface OwnerStatement {
	owner: Owner;
	period: string;
	lines: StatementLine[];
	expenses: (Expense & { propertyName: string })[];
	totals: ReturnType<typeof statementTotals>;
	commissionRates: number[];
}

/** Relevé du propriétaire pour un mois : loyers encaissés − commission − dépenses. */
export function ownerStatement(data: Dataset, ownerId: string, period: string): OwnerStatement | undefined {
	const owner = data.owners.find((o) => o.id === ownerId);
	if (!owner) return undefined;
	const props = data.properties.filter((p) => p.ownerId === ownerId);
	const propIds = new Set(props.map((p) => p.id));
	const lines: StatementLine[] = [];
	const rates = new Set<number>();
	for (const p of data.payments) {
		if (!p.date.startsWith(period)) continue;
		const v = leaseView(data, p.leaseId)!;
		if (!propIds.has(v.property.id)) continue;
		const mandate = data.mandates.find((m) => m.id === v.property.mandateId)!;
		rates.add(mandate.commissionRate);
		lines.push({
			paymentId: p.id,
			date: p.date,
			label: `${v.property.name} — ${v.unit.label} (${v.tenant.civility} ${v.tenant.name})`,
			amount: p.amount,
			commission: commissionOf(p.amount, mandate.commissionRate)
		});
	}
	lines.sort((a, b) => a.date.localeCompare(b.date));
	const expenses = data.expenses
		.filter((e) => propIds.has(e.propertyId) && e.date.startsWith(period))
		.map((e) => ({ ...e, propertyName: props.find((p) => p.id === e.propertyId)!.name }));
	return {
		owner,
		period,
		lines,
		expenses,
		totals: statementTotals(lines, expenses),
		commissionRates: [...rates].sort()
	};
}

export function unitContext(data: Dataset, unitId: string) {
	const unit = data.units.find((u) => u.id === unitId);
	if (!unit) return undefined;
	const property = data.properties.find((p) => p.id === unit.propertyId)!;
	const mandate = data.mandates.find((m) => m.id === property.mandateId)!;
	const owner = data.owners.find((o) => o.id === property.ownerId)!;
	return { unit, property, mandate, owner };
}

export function daysLabelSince(data: Dataset, iso: string): number {
	return daysBetween(iso, data.today);
}

/**
 * Restreint le jeu de données à certains biens (agent de terrain, bailleur, propriétaire)
 * ou à un bail (locataire). Préfigure les règles de synchronisation : chacun ne reçoit que ses lignes.
 */
export function scopeDataset(data: Dataset, scope: { propertyIds?: string[]; leaseId?: string }): Dataset {
	let leases = data.leases;
	let propertyIds: Set<string>;
	if (scope.leaseId) {
		leases = data.leases.filter((l) => l.id === scope.leaseId);
		const unitIds = new Set(leases.map((l) => l.unitId));
		propertyIds = new Set(data.units.filter((u) => unitIds.has(u.id)).map((u) => u.propertyId));
	} else if (scope.propertyIds) {
		propertyIds = new Set(scope.propertyIds);
	} else {
		return data;
	}
	const properties = data.properties.filter((p) => propertyIds.has(p.id));
	const units = data.units.filter((u) => propertyIds.has(u.propertyId) && (!scope.leaseId || leases.some((l) => l.unitId === u.id)));
	const unitIds = new Set(units.map((u) => u.id));
	if (!scope.leaseId) leases = data.leases.filter((l) => unitIds.has(l.unitId));
	const leaseIds = new Set(leases.map((l) => l.id));
	const upcomingLeases = scope.leaseId ? [] : (data.upcomingLeases ?? []).filter((l) => unitIds.has(l.unitId));
	const upcomingTenantIds = new Set(upcomingLeases.map((l) => l.tenantId));
	const ownerIds = new Set(properties.map((p) => p.ownerId));
	const mandateIds = new Set(properties.map((p) => p.mandateId));
	const tenantIds = new Set(leases.map((l) => l.tenantId));
	return {
		...data,
		owners: data.owners.filter((o) => ownerIds.has(o.id)),
		mandates: data.mandates.filter((m) => mandateIds.has(m.id)),
		properties,
		units,
		tenants: data.tenants.filter((t) => tenantIds.has(t.id)),
		leases,
		dues: data.dues.filter((d) => leaseIds.has(d.leaseId)),
		payments: data.payments.filter((p) => leaseIds.has(p.leaseId)),
		expenses: scope.leaseId ? [] : data.expenses.filter((e) => propertyIds.has(e.propertyId)),
		upcomingLeases,
		upcomingTenants: (data.upcomingTenants ?? []).filter((t) => upcomingTenantIds.has(t.id)),
		depositMovements: (data.depositMovements ?? []).filter((m) => leaseIds.has(m.leaseId)),
		settlements: (data.settlements ?? []).filter((x) => leaseIds.has(x.leaseId))
	};
}
