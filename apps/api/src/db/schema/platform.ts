/** Schéma Drizzle des abonnements et des accès d'assistance (lot 04, back-office). */
import { bigint, date, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const subscriptions = pgTable('subscriptions', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	planId: text('plan_id').notNull(),
	startsOn: date('starts_on', { mode: 'string' }).notNull(),
	endsOn: date('ends_on', { mode: 'string' }).notNull(),
	amount: bigint('amount', { mode: 'number' }).notNull(),
	paymentStatus: text('payment_status', { enum: ['pending', 'paid', 'waived'] }).notNull(),
	paymentReference: text('payment_reference'),
	paidOn: date('paid_on', { mode: 'string' }),
	recordedBy: uuid('recorded_by').notNull(),
	paymentRecordedBy: uuid('payment_recorded_by'),
	createdAt: tstz('created_at').notNull().defaultNow(),
	updatedAt: tstz('updated_at').notNull().defaultNow()
});

export const supportAccesses = pgTable('support_accesses', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	agentId: uuid('agent_id').notNull(),
	reason: text('reason').notNull(),
	startsAt: tstz('starts_at').notNull().defaultNow(),
	endsAt: tstz('ends_at').notNull(),
	closedAt: tstz('closed_at'),
	closedBy: uuid('closed_by'),
	createdAt: tstz('created_at').notNull().defaultNow()
});
