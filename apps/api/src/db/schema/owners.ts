/**
 * Propriétaires et mandats (lot 06). La migration SQL (0008) fait foi : RLS, clés composites, versionnage par
 * trigger, règle 12 (index uniques partiels), bailleur à fiche unique. Lu et écrit par le seul module owners (règle
 * ESLint d'import, CLAUDE.md §4) ; pas exporté par l'index du schéma.
 */
import { bigint, boolean, date, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const owners = pgTable('owners', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	type: text('type', { enum: ['person', 'company', 'group'] }).notNull(),
	name: text('name').notNull(),
	phone: text('phone').notNull(),
	email: text('email'),
	address: text('address'),
	country: text('country').notNull(),
	representativeName: text('representative_name'),
	representativePhone: text('representative_phone'),
	notes: text('notes'),
	userId: uuid('user_id'),
	status: text('status', { enum: ['active', 'archived'] }).notNull(),
	archivedAt: tstz('archived_at'),
	createdBy: uuid('created_by'),
	createdAt: tstz('created_at').notNull().defaultNow(),
	updatedAt: tstz('updated_at').notNull().defaultNow()
});

const mandateTerms = {
	startsOn: date('starts_on', { mode: 'string' }).notNull(),
	endsOn: date('ends_on', { mode: 'string' }),
	commissionBasis: text('commission_basis', { enum: ['percent_of_collected', 'fixed_per_month', 'fixed_per_operation'] }),
	commissionRateBp: integer('commission_rate_bp'),
	commissionAmount: bigint('commission_amount', { mode: 'number' }),
	canPublish: boolean('can_publish').notNull(),
	canTakePhotos: boolean('can_take_photos').notNull(),
	canCollectFunds: boolean('can_collect_funds').notNull(),
	canSignLeases: boolean('can_sign_leases').notNull(),
	exclusive: boolean('exclusive').notNull(),
	status: text('status', { enum: ['active', 'expired', 'revoked'] }).notNull(),
	revokedAt: tstz('revoked_at'),
	revocationReason: text('revocation_reason'),
	expiredAt: tstz('expired_at')
};

export const mandates = pgTable('mandates', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	ownerId: uuid('owner_id').notNull(),
	type: text('type', { enum: ['rental_management', 'letting', 'sale', 'self_managed', 'other'] }).notNull(),
	...mandateTerms,
	version: integer('version').notNull(),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	createdAt: tstz('created_at').notNull().defaultNow(),
	updatedAt: tstz('updated_at').notNull().defaultNow()
});

/** Écrite par la base seule (trigger) : l'application la lit, jamais ne l'écrit. */
export const mandateVersions = pgTable('mandate_versions', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	mandateId: uuid('mandate_id').notNull(),
	version: integer('version').notNull(),
	...mandateTerms,
	changedBy: uuid('changed_by'),
	recordedAt: tstz('recorded_at').notNull()
});

/** Remplie au lot 07 ; `management_active` est calculé par la base. */
export const mandateScopes = pgTable('mandate_scopes', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	mandateId: uuid('mandate_id').notNull(),
	propertyId: uuid('property_id').notNull(),
	unitId: uuid('unit_id'),
	viaProperty: boolean('via_property').notNull(),
	managementActive: boolean('management_active').notNull(),
	createdAt: tstz('created_at').notNull().defaultNow()
});
