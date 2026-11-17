/**
 * Relances, dépenses, relevés et reversements de test (lot 10), écrits en SQL dans le contexte d'une organisation
 * (client déjà dans sa transaction de contexte). Les règles sont celles de la base (migration 0017) ; l'API viendra à
 * l'étape 3.
 */
import { newId } from '@ziga/shared/ids';
import { newStatementToken } from '@ziga/shared/statements';
import type pg from 'pg';
import { sha256 } from './payments.js';

export interface ExpenseSql {
	propertyId: string;
	unitId?: string | null;
	leaseId?: string | null;
	amount?: number;
	paidBy?: 'organization' | 'owner' | 'tenant';
	borneBy?: 'owner' | 'organization' | 'tenant';
	recovery?: 'owner_statement' | 'deposit' | 'claimed_from_tenant' | 'none';
	spentOn?: string;
}

/** Une dépense (par défaut : avancée par l'organisation pour le propriétaire, déduite de son relevé, 15 000 FCFA). */
export async function insertExpense(c: pg.Client, organizationId: string, e: ExpenseSql): Promise<string> {
	const id = newId();
	await c.query(
		`insert into expenses (id, organization_id, property_id, unit_id, lease_id, spent_on, category, description, amount, paid_by, borne_by,
			recovery)
		 values ($1, $2, $3, $4, $5, $6, 'plumbing', 'Fuite sous l''évier', $7, $8, $9, $10)`,
		[
			id,
			organizationId,
			e.propertyId,
			e.unitId ?? null,
			e.leaseId ?? null,
			e.spentOn ?? '2026-09-12',
			e.amount ?? 15_000,
			e.paidBy ?? 'organization',
			e.borneBy ?? 'owner',
			e.recovery ?? 'owner_statement'
		]
	);
	return id;
}

export interface StatementTotalsSql {
	rent?: number;
	charges?: number;
	commission?: number;
	expenses?: number;
	carried?: number;
}

/** Un brouillon de relevé ; les totaux se recalculent comme dans statements.ts (encaissé, net). */
export async function insertStatement(
	c: pg.Client,
	organizationId: string,
	ownerId: string,
	month: string,
	extra: StatementTotalsSql & { version?: number; corrects?: string | null } = {}
): Promise<string> {
	const id = newId();
	const rent = extra.rent ?? 75_000;
	const charges = extra.charges ?? 5_000;
	const commission = extra.commission ?? 7_500;
	const expenses = extra.expenses ?? 0;
	const carried = extra.carried ?? 0;
	const collected = rent + charges;
	await c.query(
		`insert into owner_statements (id, organization_id, owner_id, month, version, corrects_statement_id, revision, rent_collected,
			charges_collected, collected, rent_collected_by_owner, charges_collected_by_owner, commission, expenses, carried_balance, net, snapshot)
		 values ($1, $2, $3, $4, $5, $6, '0a1b2c3d', $7, $8, $9, 0, 0, $10, $11, $12, $13, '{"month":"test"}'::jsonb)`,
		[
			id,
			organizationId,
			ownerId,
			month,
			extra.version ?? 1,
			extra.corrects ?? null,
			rent,
			charges,
			collected,
			commission,
			expenses,
			carried,
			collected - commission + expenses + carried
		]
	);
	return id;
}

/** Émission par la base (ordre des mois, date, auteur) ; les éléments s'écrivent ensuite dans la même transaction. */
export async function issueStatement(c: pg.Client, organizationId: string, statementId: string, userId: string): Promise<void> {
	await c.query(`update owner_statements set status = 'issued', issued_by = $3 where organization_id = $1 and id = $2`, [
		organizationId,
		statementId,
		userId
	]);
}

export interface LineSql {
	kind: 'allocation' | 'monthly_fee' | 'operation_fee' | 'expense' | 'expense_cancellation' | 'carried_balance';
	role?: 'line' | 'neutralized';
	allocationId?: string;
	expenseId?: string;
	mandateId?: string;
	feeMonth?: string;
	leaseId?: string;
	carriedStatementId?: string;
}

export async function insertLine(c: pg.Client, organizationId: string, statementId: string, l: LineSql): Promise<string> {
	const r = await c.query(
		`insert into owner_statement_lines (id, organization_id, statement_id, kind, role, allocation_id, expense_id, mandate_id, fee_month, lease_id,
			carried_statement_id)
		 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning item_key`,
		[
			newId(),
			organizationId,
			statementId,
			l.kind,
			l.role ?? 'line',
			l.allocationId ?? null,
			l.expenseId ?? null,
			l.mandateId ?? null,
			l.feeMonth ?? null,
			l.leaseId ?? null,
			l.carriedStatementId ?? null
		]
	);
	return r.rows[0].item_key as string;
}

/** Lien /s/<jeton> : renvoie le jeton (gardé par le test), la base n'en a que l'empreinte. */
export async function insertStatementToken(c: pg.Client, organizationId: string, statementId: string): Promise<string> {
	const token = newStatementToken();
	await c.query(`insert into owner_statement_tokens (id, organization_id, statement_id, token_hash) values ($1, $2, $3, $4)`, [
		newId(),
		organizationId,
		statementId,
		sha256(token)
	]);
	return token;
}

export async function insertPayout(
	c: pg.Client,
	organizationId: string,
	statementId: string,
	ownerId: string,
	amount: number,
	extra: { reverses?: string; reason?: string; paidOn?: string } = {}
): Promise<string> {
	const id = newId();
	await c.query(
		`insert into owner_payouts (id, organization_id, kind, reverses_payout_id, owner_id, statement_id, amount, paid_on, method, reason)
		 values ($1, $2, $3, $4, $5, $6, $7, $8, 'mobile_money', $9)`,
		[
			id,
			organizationId,
			extra.reverses ? 'reversal' : 'payout',
			extra.reverses ?? null,
			ownerId,
			statementId,
			amount,
			extra.paidOn ?? '2026-10-05',
			extra.reverses ? (extra.reason ?? 'Erreur de montant') : null
		]
	);
	return id;
}

export async function insertReminder(
	c: pg.Client,
	organizationId: string,
	tenantId: string,
	extra: { dueIds?: string[]; expenseIds?: string[]; channel?: string; level?: number | null } = {}
): Promise<string> {
	const id = newId();
	const channel = extra.channel ?? 'whatsapp_link';
	await c.query(
		`insert into reminders (id, organization_id, tenant_id, rent_due_ids, expense_ids, channel, template_level) values ($1, $2, $3, $4, $5, $6, $7)`,
		[
			id,
			organizationId,
			tenantId,
			extra.dueIds ?? [],
			extra.expenseIds ?? [],
			channel,
			extra.level === undefined ? (channel === 'whatsapp_link' || channel === 'sms' ? 1 : null) : extra.level
		]
	);
	return id;
}
