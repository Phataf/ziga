/**
 * Schéma Drizzle du module features (lot 04) : catalogue, formules, exceptions. Seul le module `features`
 * (et le back-office, qui les modifie) importe ce fichier : règle ESLint et test d'architecture.
 */
import { boolean, integer, pgTable, primaryKey, text, timestamp, uuid, bigint } from 'drizzle-orm/pg-core';

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const plans = pgTable('plans', {
	id: text('id', { enum: ['discovery', 'essential', 'pro', 'custom'] }).primaryKey(),
	label: text('label').notNull(),
	monthlyPrice: bigint('monthly_price', { mode: 'number' }),
	yearlyPrice: bigint('yearly_price', { mode: 'number' }),
	maxUnits: integer('max_units'),
	maxUsers: integer('max_users'),
	updatedAt: tstz('updated_at').notNull().defaultNow(),
	updatedBy: uuid('updated_by')
});

export const features = pgTable('features', {
	key: text('key').primaryKey(),
	description: text('description').notNull(),
	globalMode: text('global_mode', { enum: ['disabled', 'restricted', 'enabled'] }).notNull(),
	planBound: boolean('plan_bound').notNull(),
	requires: text('requires').array().notNull(),
	updatedAt: tstz('updated_at').notNull().defaultNow(),
	updatedBy: uuid('updated_by')
});

export const planFeatures = pgTable(
	'plan_features',
	{
		planId: text('plan_id').notNull(),
		featureKey: text('feature_key').notNull(),
		quota: integer('quota')
	},
	(t) => [primaryKey({ columns: [t.planId, t.featureKey] })]
);

export const featureOverrides = pgTable('feature_overrides', {
	id: uuid('id').primaryKey(),
	featureKey: text('feature_key').notNull(),
	scope: text('scope', { enum: ['organization', 'user'] }).notNull(),
	organizationId: uuid('organization_id'),
	userId: uuid('user_id'),
	value: boolean('value').notNull(),
	reason: text('reason').notNull(),
	startsAt: tstz('starts_at').notNull().defaultNow(),
	endsAt: tstz('ends_at'),
	createdBy: uuid('created_by').notNull(),
	createdAt: tstz('created_at').notNull().defaultNow(),
	revokedAt: tstz('revoked_at'),
	revokedBy: uuid('revoked_by')
});

export const quotaOverrides = pgTable('quota_overrides', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	quota: text('quota', { enum: ['users', 'units', 'owner_statements'] }).notNull(),
	value: integer('value').notNull(),
	reason: text('reason').notNull(),
	startsAt: tstz('starts_at').notNull().defaultNow(),
	endsAt: tstz('ends_at'),
	createdBy: uuid('created_by').notNull(),
	createdAt: tstz('created_at').notNull().defaultNow(),
	revokedAt: tstz('revoked_at'),
	revokedBy: uuid('revoked_by')
});

export const organizationFeatureSettings = pgTable(
	'organization_feature_settings',
	{
		organizationId: uuid('organization_id').notNull(),
		featureKey: text('feature_key').notNull(),
		disabledByOrganization: boolean('disabled_by_organization').notNull(),
		updatedBy: uuid('updated_by').notNull(),
		updatedAt: tstz('updated_at').notNull().defaultNow()
	},
	(t) => [primaryKey({ columns: [t.organizationId, t.featureKey] })]
);
