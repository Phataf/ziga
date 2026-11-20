/**
 * Encaissements, imputations et reçus (lot 09). La migration SQL (0015) fait foi : RLS, clés composites, ajout seul
 * (règle 3), machine d'états, montant payé des échéances tenu par les imputations, numérotation des reçus par la base
 * (règle 9). Lu et écrit par le seul module payments (règle ESLint d'import, CLAUDE.md §4) ; pas exporté par l'index du
 * schéma.
 */
import { bigint, customType, date, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { AllocationDirection, AllocationTarget } from '@ziga/shared/allocation';
import type { MobileMoneyOperator, PaymentKind, PaymentMeans, PaymentPurpose, PaymentStatus } from '@ziga/shared/payments';
import type { ReceiptSnapshot, ReceiptStatus } from '@ziga/shared/receipts';

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const day = (name: string) => date(name, { mode: 'string' });
const fcfa = (name: string) => bigint(name, { mode: 'number' });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/** Ajout seul : seuls le statut et les champs de validation et d'annulation changent, une fois chacun (trigger). */
export const payments = pgTable('payments', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	kind: text('kind').$type<PaymentKind>().notNull(),
	reversesPaymentId: uuid('reverses_payment_id'),
	leaseId: uuid('lease_id').notNull(),
	/** Recopié du bail par la base. */
	tenantId: uuid('tenant_id').notNull(),
	purpose: text('purpose').$type<PaymentPurpose>().notNull(),
	depositAccountId: uuid('deposit_account_id'),
	/** Lot 10 : dépense réclamée au locataire (objet `expense`). */
	expenseId: uuid('expense_id'),
	amount: fcfa('amount').notNull(),
	method: text('method').$type<PaymentMeans>().notNull(),
	operator: text('operator').$type<MobileMoneyOperator>(),
	transactionReference: text('transaction_reference'),
	/** Colonne générée (référence normalisée) : jamais écrite. */
	referenceKey: text('reference_key'),
	paidOn: day('paid_on').notNull(),
	status: text('status').$type<PaymentStatus>().notNull(),
	provider: text('provider').notNull(),
	providerReference: text('provider_reference'),
	idempotencyKey: text('idempotency_key').notNull(),
	note: text('note'),
	recordedBy: uuid('recorded_by'),
	confirmedAt: tstz('confirmed_at'),
	confirmedBy: uuid('confirmed_by'),
	cancellationReason: text('cancellation_reason'),
	cancelledAt: tstz('cancelled_at'),
	cancelledBy: uuid('cancelled_by'),
	createdAt: tstz('created_at').notNull().defaultNow(),
	updatedAt: tstz('updated_at').notNull().defaultNow()
});

/** Ajout seul (trigger) ; tient `rent_dues.amount_paid` et les mouvements de caution. */
export const paymentAllocations = pgTable('payment_allocations', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	paymentId: uuid('payment_id').notNull(),
	leaseId: uuid('lease_id').notNull(),
	target: text('target').$type<AllocationTarget>().notNull(),
	rentDueId: uuid('rent_due_id'),
	depositAccountId: uuid('deposit_account_id'),
	expenseId: uuid('expense_id'),
	direction: text('direction').$type<AllocationDirection>().notNull(),
	amount: fcfa('amount').notNull(),
	/** Lot 10 bis : provenance recopiée de l'encaissement par la base (`deposit` : imputation sur caution). */
	source: text('source').$type<'tenant' | 'deposit'>().notNull().default('tenant'),
	createdBy: uuid('created_by'),
	createdAt: tstz('created_at').notNull().defaultNow()
});

/** Numéro, année et rang attribués par la base à la validation ; jamais supprimé. */
export const receipts = pgTable('receipts', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	paymentId: uuid('payment_id').notNull(),
	/** Recopiés de l'encaissement par la base. */
	leaseId: uuid('lease_id').notNull(),
	purpose: text('purpose').$type<PaymentPurpose>().notNull(),
	provisionalNumber: text('provisional_number').notNull(),
	number: text('number'),
	year: integer('year'),
	sequence: bigint('sequence', { mode: 'number' }),
	status: text('status').$type<ReceiptStatus>().notNull(),
	issuedOn: day('issued_on'),
	issuedAt: tstz('issued_at'),
	snapshot: jsonb('snapshot').$type<ReceiptSnapshot>(),
	logoId: uuid('logo_id'),
	/** Lot 10 bis : provenance recopiée de l'encaissement par la base. */
	source: text('source').$type<'tenant' | 'deposit'>().notNull().default('tenant'),
	pdfA6Key: text('pdf_a6_key'),
	pdfTicketKey: text('pdf_ticket_key'),
	pdfGeneratedAt: tstz('pdf_generated_at'),
	cancelledAt: tstz('cancelled_at'),
	createdAt: tstz('created_at').notNull().defaultNow(),
	updatedAt: tstz('updated_at').notNull().defaultNow()
});

/** Écrit par la base seule (numérotation, set_receipt_first_number). */
export const receiptCounters = pgTable('receipt_counters', {
	organizationId: uuid('organization_id').notNull(),
	year: integer('year').notNull(),
	nextSequence: bigint('next_sequence', { mode: 'number' }).notNull(),
	firstNumber: bigint('first_number', { mode: 'number' }),
	firstNumberSetBy: uuid('first_number_set_by'),
	firstNumberSetAt: tstz('first_number_set_at')
});

/** Empreintes SHA-256 des jetons ; le jeton n'est jamais gardé. */
export const receiptTokens = pgTable('receipt_tokens', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	receiptId: uuid('receipt_id').notNull(),
	kind: text('kind', { enum: ['verification', 'share'] }).notNull(),
	tokenHash: bytea('token_hash').notNull(),
	createdBy: uuid('created_by'),
	createdAt: tstz('created_at').notNull().defaultNow(),
	revokedAt: tstz('revoked_at'),
	revokedBy: uuid('revoked_by')
});
