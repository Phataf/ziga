/**
 * Relances, dépenses, relevés propriétaires et reversements (lot 10). La migration SQL (0017) fait foi : RLS, clés
 * composites, ajout seul, ordre d'émission des relevés, éléments consommés une seule fois, reversements plafonnés au net.
 * Lu et écrit par le seul module collections (règle ESLint d'import, CLAUDE.md §4) ; pas exporté par l'index du schéma.
 */
import type { ExpenseBearer, ExpenseCategory, ExpensePayer, ExpenseRecovery, ExpenseStatus } from '@ziga/shared/expenses';
import type { ReminderChannel } from '@ziga/shared/reminders';
import type { PayoutMethod, StatementItemKind, StatementStatus } from '@ziga/shared/statements';
import { bigint, customType, date, integer, jsonb, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const day = (name: string) => date(name, { mode: 'string' });
const fcfa = (name: string) => bigint(name, { mode: 'number' });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/** Ajout seul (trigger). */
export const reminders = pgTable('reminders', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	tenantId: uuid('tenant_id').notNull(),
	rentDueIds: uuid('rent_due_ids').array().notNull(),
	expenseIds: uuid('expense_ids').array().notNull(),
	channel: text('channel').$type<ReminderChannel>().notNull(),
	templateLevel: smallint('template_level'),
	note: text('note'),
	sentAt: tstz('sent_at').notNull().defaultNow(),
	sentBy: uuid('sent_by'),
	createdAt: tstz('created_at').notNull().defaultNow()
});

export const reminderSettings = pgTable('reminder_settings', {
	organizationId: uuid('organization_id').primaryKey(),
	template1: text('template_1').notNull(),
	template2: text('template_2').notNull(),
	template3: text('template_3').notNull(),
	offset1: smallint('offset_1').notNull(),
	offset2: smallint('offset_2').notNull(),
	offset3: smallint('offset_3').notNull(),
	updatedBy: uuid('updated_by'),
	updatedAt: tstz('updated_at').notNull().defaultNow()
});

/** Ajout seul : seuls l'annulation (une fois) et le justificatif (une fois) changent (trigger). */
export const expenses = pgTable('expenses', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	propertyId: uuid('property_id').notNull(),
	unitId: uuid('unit_id'),
	leaseId: uuid('lease_id'),
	spentOn: day('spent_on').notNull(),
	category: text('category').$type<ExpenseCategory>().notNull(),
	description: text('description').notNull(),
	supplier: text('supplier'),
	amount: fcfa('amount').notNull(),
	documentId: uuid('document_id'),
	paidBy: text('paid_by').$type<ExpensePayer>().notNull(),
	borneBy: text('borne_by').$type<ExpenseBearer>().notNull(),
	recovery: text('recovery').$type<ExpenseRecovery>().notNull(),
	status: text('status').$type<ExpenseStatus>().notNull().default('recorded'),
	cancellationReason: text('cancellation_reason'),
	cancelledAt: tstz('cancelled_at'),
	cancelledBy: uuid('cancelled_by'),
	recordedBy: uuid('recorded_by'),
	createdAt: tstz('created_at').notNull().defaultNow(),
	updatedAt: tstz('updated_at').notNull().defaultNow()
});

/** Brouillon recalculé, puis émis et figé (trigger) ; totaux signés. */
export const ownerStatements = pgTable('owner_statements', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	ownerId: uuid('owner_id').notNull(),
	month: text('month').notNull(),
	version: integer('version').notNull(),
	correctsStatementId: uuid('corrects_statement_id'),
	status: text('status').$type<StatementStatus>().notNull(),
	revision: text('revision').notNull(),
	rentCollected: fcfa('rent_collected').notNull(),
	chargesCollected: fcfa('charges_collected').notNull(),
	collected: fcfa('collected').notNull(),
	rentCollectedByOwner: fcfa('rent_collected_by_owner').notNull(),
	chargesCollectedByOwner: fcfa('charges_collected_by_owner').notNull(),
	commission: fcfa('commission').notNull(),
	expenses: fcfa('expenses').notNull(),
	carriedBalance: fcfa('carried_balance').notNull(),
	net: fcfa('net').notNull(),
	snapshot: jsonb('snapshot').notNull(),
	logoId: uuid('logo_id'),
	generatedAt: tstz('generated_at').notNull().defaultNow(),
	generatedBy: uuid('generated_by'),
	issuedOn: day('issued_on'),
	issuedAt: tstz('issued_at'),
	issuedBy: uuid('issued_by'),
	pdfKey: text('pdf_key'),
	pdfGeneratedAt: tstz('pdf_generated_at'),
	createdAt: tstz('created_at').notNull().defaultNow(),
	updatedAt: tstz('updated_at').notNull().defaultNow()
});

/** Éléments consommés, écrits à l'émission ; `item_key` générée par la base. */
export const ownerStatementLines = pgTable('owner_statement_lines', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	statementId: uuid('statement_id').notNull(),
	kind: text('kind').$type<StatementItemKind>().notNull(),
	role: text('role').$type<'line' | 'neutralized'>().notNull(),
	allocationId: uuid('allocation_id'),
	expenseId: uuid('expense_id'),
	mandateId: uuid('mandate_id'),
	feeMonth: text('fee_month'),
	leaseId: uuid('lease_id'),
	carriedStatementId: uuid('carried_statement_id'),
	itemKey: text('item_key'),
	createdAt: tstz('created_at').notNull().defaultNow()
});

/** Empreinte du jeton seulement ; 90 jours ; révocable une fois. */
export const ownerStatementTokens = pgTable('owner_statement_tokens', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	statementId: uuid('statement_id').notNull(),
	tokenHash: bytea('token_hash').notNull(),
	createdBy: uuid('created_by'),
	createdAt: tstz('created_at').notNull().defaultNow(),
	expiresAt: tstz('expires_at').notNull(),
	revokedAt: tstz('revoked_at'),
	revokedBy: uuid('revoked_by')
});

/** Ajout seul ; contre-écriture à l'identique. */
export const ownerPayouts = pgTable('owner_payouts', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	kind: text('kind').$type<'payout' | 'reversal'>().notNull(),
	reversesPayoutId: uuid('reverses_payout_id'),
	ownerId: uuid('owner_id').notNull(),
	statementId: uuid('statement_id').notNull(),
	amount: fcfa('amount').notNull(),
	paidOn: day('paid_on').notNull(),
	method: text('method').$type<PayoutMethod>().notNull(),
	reference: text('reference'),
	note: text('note'),
	reason: text('reason'),
	recordedBy: uuid('recorded_by'),
	createdAt: tstz('created_at').notNull().defaultNow()
});
