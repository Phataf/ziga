/**
 * Vues locales du lot 10 (impayés, relances, dépenses, relevés, accueil) : les lignes de la base de l'appareil
 * (booléens en 0 ou 1, tableaux en texte JSON, dates en texte) deviennent les entrées des fonctions pures de
 * packages/shared, les mêmes que celles de l'API. Aucune règle métier ici : seulement des conversions (CLAUDE.md §6).
 */
import { arrearsGroups, type ArrearsFilter, type ArrearsGroup, type ArrearsUnitContext } from '@ziga/shared/collections';
import { dashboardSummary, type DashboardSummary } from '@ziga/shared/dashboard';
import { rentDueOverdueFrom } from '@ziga/shared/leases';
import { expenseEffect, type ExpenseCategory, type ExpenseEffect, type ExpenseRoles } from '@ziga/shared/expenses';
import {
	DEFAULT_REMINDER_OFFSETS,
	DEFAULT_REMINDER_TEMPLATES,
	reminderMessage,
	waMeLink,
	type CreateReminderInput,
	type ReminderChannel,
	type ReminderLevel
} from '@ziga/shared/reminders';
import {
	addMonthsToMonth,
	monthOfDate,
	statementDocument,
	type StatementDocument,
	type StatementSnapshot,
	type StatementStatus
} from '@ziga/shared/statements';

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const num = (v: unknown): number => Number(v ?? 0);

/** Tableau PostgreSQL synchronisé en texte JSON (docs/SYNC.md §3). */
export function jsonArray(v: unknown): string[] {
	if (Array.isArray(v)) return v.map(String);
	if (typeof v !== 'string' || !v) return [];
	try {
		const parsed = JSON.parse(v) as unknown;
		return Array.isArray(parsed) ? parsed.map(String) : [];
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------- relances : réglages et message

export interface ReminderSettings {
	templates: [string, string, string];
	offsets: [number, number, number];
}

export function reminderSettingsOf(row: Row | null | undefined): ReminderSettings {
	if (!row) return { templates: [...DEFAULT_REMINDER_TEMPLATES], offsets: [...DEFAULT_REMINDER_OFFSETS] };
	return {
		templates: [String(row.template_1), String(row.template_2), String(row.template_3)],
		offsets: [num(row.offset_1), num(row.offset_2), num(row.offset_3)]
	};
}

/** Niveau de modèle proposé : celui de la suggestion, sinon le dernier seuil franchi, au moins le rappel courtois. */
export function levelFor(group: ArrearsGroup): ReminderLevel {
	return group.suggestion?.level ?? 1;
}

/** Message d'une relance (modèle de l'organisation, échéances et dépenses relançables du locataire). */
export function groupMessage(
	group: ArrearsGroup,
	level: ReminderLevel,
	settings: ReminderSettings,
	org: { name: string; phone: string | null }
): string {
	const items = group.remindableItems;
	return reminderMessage(settings.templates[level - 1]!, {
		tenantName: group.tenantName,
		amount: group.remindable,
		subject: {
			dues: items.filter((i) => i.kind === 'rent_due').map((i) => ({ periodStart: i.periodStart! })),
			claims: items.filter((i) => i.kind === 'expense_claim').map((i) => ({ category: i.category!, date: i.dueOn }))
		},
		organizationName: org.name,
		organizationPhone: org.phone
	});
}

/** Lien WhatsApp d'une relance, ou null sans numéro. */
export function groupLink(group: ArrearsGroup, text: string): string | null {
	return group.phone ? waMeLink(group.phone, text) : null;
}

/** Relance à enregistrer (schéma partagé) : les échéances et dépenses relançables du locataire. */
export function reminderFor(
	group: ArrearsGroup,
	id: string,
	channel: ReminderChannel,
	level: ReminderLevel | null,
	note: string | null = null
): CreateReminderInput {
	const items = group.items.filter((i) => !i.awaitingValidation);
	const subject = items.length ? items : group.items;
	return {
		id,
		tenantId: group.tenantId,
		rentDueIds: subject.filter((i) => i.kind === 'rent_due').map((i) => i.id),
		expenseIds: subject.filter((i) => i.kind === 'expense_claim').map((i) => i.id),
		channel,
		templateLevel: level,
		note
	};
}

// ---------------------------------------------------------------- impayés

export interface LocalArrearsRows {
	dues: Row[];
	claims: Row[];
	tenants: Row[];
	awaiting: Row[];
	reminders: Row[];
	units: Row[];
	settings: Row | null;
}

export function unitContextsOf(units: Row[]): Map<string, ArrearsUnitContext> {
	return new Map(
		units.map((u) => [
			String(u.id),
			{
				neighborhoodId: str(u.neighborhood_id),
				ownerId: str(u.owner_id),
				agentIds: str(u.assigned_agent_id) ? [String(u.assigned_agent_id)] : []
			}
		])
	);
}

/** Impayés calculés sur l'appareil, par la même fonction que l'API (`arrearsGroups`). */
export function localArrears(rows: LocalArrearsRows, today: string, filter: ArrearsFilter = {}, includeDueToday = false): ArrearsGroup[] {
	const now = `${today}T23:59:59.000Z`;
	return arrearsGroups({
		today,
		dues: rows.dues.map((d) => ({
			id: String(d.id),
			leaseId: String(d.lease_id),
			tenantId: String(d.tenant_id),
			unitId: String(d.unit_id),
			dueOn: String(d.due_on),
			periodStart: String(d.period_start),
			periodEnd: String(d.period_end),
			amountDue: num(d.amount_due),
			amountPaid: num(d.amount_paid),
			waived: d.status === 'waived',
			overdueFrom: rentDueOverdueFrom(
				{
					dueOn: String(d.due_on),
					periodStart: String(d.period_start),
					isAdvance: num(d.is_advance) === 1,
					prorated: num(d.prorated) === 1
				},
				String(d.lease_starts_on)
			)
		})),
		claims: rows.claims.map((c) => ({
			expenseId: String(c.id),
			leaseId: String(c.lease_id),
			tenantId: String(c.tenant_id),
			unitId: str(c.unit_id) ?? str(c.lease_unit_id),
			date: String(c.spent_on),
			category: String(c.category) as ExpenseCategory,
			description: String(c.description),
			amount: num(c.amount),
			recovered: num(c.recovered),
			cancelled: c.status === 'cancelled'
		})),
		tenants: rows.tenants.map((t) => ({ id: String(t.id), name: String(t.full_name ?? ''), phone: str(t.phone) })),
		pendingRentPayments: rows.awaiting
			.filter((p) => p.purpose === 'rent')
			.map((p) => ({ leaseId: String(p.lease_id), amount: num(p.amount) })),
		pendingClaimPayments: rows.awaiting
			.filter((p) => p.purpose === 'expense' && p.expense_id)
			.map((p) => ({ expenseId: String(p.expense_id), amount: num(p.amount) })),
		// Une relance pas encore synchronisée n'a pas de date d'envoi : elle compte comme envoyée aujourd'hui.
		reminders: rows.reminders.map((r) => ({
			tenantId: String(r.tenant_id),
			sentAt: str(r.sent_at) ?? now,
			channel: String(r.channel) as ReminderChannel
		})),
		offsets: reminderSettingsOf(rows.settings).offsets,
		filter,
		units: unitContextsOf(rows.units),
		includeDueToday
	});
}

// ---------------------------------------------------------------- accueil

export function localDashboard(dues: Row[], payments: Row[], today: string, statementsToIssue: number): DashboardSummary {
	return dashboardSummary({
		today,
		dues: dues.map((d) => ({
			id: String(d.id),
			dueOn: String(d.due_on),
			amountDue: num(d.amount_due),
			amountPaid: num(d.amount_paid),
			waived: d.status === 'waived',
			overdueFrom: rentDueOverdueFrom(
				{
					dueOn: String(d.due_on),
					periodStart: String(d.period_start),
					isAdvance: num(d.is_advance) === 1,
					prorated: num(d.prorated) === 1
				},
				String(d.lease_starts_on)
			)
		})),
		confirmedRentPayments: payments.map((p) => ({ amount: num(p.amount), paidOn: String(p.paid_on) })),
		statementsToIssue
	});
}

// ---------------------------------------------------------------- dépenses

export interface LocalExpense extends ExpenseRoles {
	id: string;
	propertyId: string;
	propertyName: string;
	unitId: string | null;
	unitLabel: string | null;
	leaseId: string | null;
	spentOn: string;
	category: ExpenseCategory;
	description: string;
	supplier: string | null;
	amount: number;
	status: 'recorded' | 'cancelled';
	effect: ExpenseEffect | null;
	cancellationReason: string | null;
}

export function toExpense(r: Row): LocalExpense {
	const roles = { paidBy: String(r.paid_by), borneBy: String(r.borne_by), recovery: String(r.recovery) } as ExpenseRoles;
	return {
		id: String(r.id),
		propertyId: String(r.property_id),
		propertyName: String(r.property_name ?? ''),
		unitId: str(r.unit_id),
		unitLabel: str(r.unit_label),
		leaseId: str(r.lease_id),
		spentOn: String(r.spent_on),
		category: String(r.category) as ExpenseCategory,
		description: String(r.description ?? ''),
		supplier: str(r.supplier),
		amount: num(r.amount),
		status: r.status === 'cancelled' ? 'cancelled' : 'recorded',
		effect: expenseEffect(roles),
		cancellationReason: str(r.cancellation_reason),
		...roles
	};
}

// ---------------------------------------------------------------- relevés

export interface LocalStatement {
	id: string;
	ownerId: string;
	ownerName: string;
	month: string;
	version: number;
	correctsStatementId: string | null;
	status: StatementStatus;
	revision: string;
	net: number;
	issuedOn: string | null;
	pdfAvailable: boolean;
	snapshot: StatementSnapshot | null;
}

export function toStatement(r: Row): LocalStatement {
	let snapshot: StatementSnapshot | null;
	try {
		snapshot = typeof r.snapshot === 'string' ? (JSON.parse(r.snapshot) as StatementSnapshot) : ((r.snapshot as StatementSnapshot) ?? null);
	} catch {
		snapshot = null;
	}
	return {
		id: String(r.id),
		ownerId: String(r.owner_id),
		ownerName: snapshot?.owner.displayName ?? '',
		month: String(r.month),
		version: num(r.version),
		correctsStatementId: str(r.corrects_statement_id),
		status: r.status === 'issued' ? 'issued' : 'draft',
		revision: String(r.revision ?? ''),
		net: num(r.net),
		issuedOn: str(r.issued_on),
		pdfAvailable: !!str(r.pdf_generated_at),
		snapshot
	};
}

/** Document du relevé (même contenu que le PDF et la page partagée), à partir de la copie synchronisée. */
export function documentOf(s: LocalStatement): StatementDocument | null {
	return s.snapshot ? statementDocument({ ...s.snapshot, issuedOn: s.issuedOn }) : null;
}

/** Les `n` derniers mois terminés, du plus récent au plus ancien (choix du mois des relevés). */
export function recentMonths(today: string, n = 12): string[] {
	const current = monthOfDate(today);
	return Array.from({ length: n }, (_, i) => addMonthsToMonth(current, -(i + 1)));
}

/**
 * Propriétaires qui ont un relevé à faire pour un mois : ceux d'un mandat de gestion, de mise en location ou autre en
 * vigueur pendant le mois (jamais un bailleur particulier : son organisation n'a pas de relevé).
 */
export function ownersWithStatement(mandates: Row[], month: string): string[] {
	const start = `${month}-01`;
	const end = `${month}-31`;
	const ids = mandates
		.filter((m) => ['rental_management', 'letting', 'other'].includes(String(m.type)))
		.filter((m) => String(m.starts_on) <= end && (!str(m.ends_on) || String(m.ends_on) >= start))
		.filter((m) => !str(m.revoked_at) || String(m.revoked_at).slice(0, 10) >= start)
		.map((m) => String(m.owner_id));
	return [...new Set(ids)];
}

/** Dernière version de chaque relevé d'un mois, par propriétaire. */
export function latestByOwner(statements: LocalStatement[], month: string): Map<string, LocalStatement> {
	const out = new Map<string, LocalStatement>();
	for (const s of statements) {
		if (s.month !== month) continue;
		const cur = out.get(s.ownerId);
		if (!cur || s.version > cur.version) out.set(s.ownerId, s);
	}
	return out;
}
