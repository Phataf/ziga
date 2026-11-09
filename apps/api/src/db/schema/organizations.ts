/**
 * Schéma Drizzle des modules organizations et audit (lot 03). La migration SQL (0002) fait foi : règles
 * d'accès (RLS), triggers (bailleur à un seul membre, dernier directeur, journal en ajout seul) et clés composites.
 */
import { customType, date, inet, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const organizations = pgTable('organizations', {
	id: uuid('id').primaryKey(),
	type: text('type', { enum: ['agency', 'landlord'] }).notNull(),
	legalName: text('legal_name').notNull(),
	tradeName: text('trade_name'),
	phone: text('phone').notNull(),
	address: text('address'),
	commune: text('commune').notNull(),
	poBox: text('po_box'),
	rccm: text('rccm'),
	ifu: text('ifu'),
	repName: text('rep_name'),
	repTitle: text('rep_title'),
	repProfession: text('rep_profession'),
	repAddress: text('rep_address'),
	repNationality: text('rep_nationality'),
	repIdType: text('rep_id_type', { enum: ['cnib', 'passport', 'consular_card', 'residence_card', 'other'] }),
	repIdTypeOther: text('rep_id_type_other'),
	repIdNumber: text('rep_id_number'),
	repIdIssuedOn: date('rep_id_issued_on', { mode: 'string' }),
	repIdIssuedBy: text('rep_id_issued_by'),
	verificationStatus: text('verification_status', { enum: ['pending', 'verified', 'suspended'] }).notNull(),
	planId: text('plan_id').notNull().default('discovery'),
	acceptedPaymentMethods: text('accepted_payment_methods', { enum: ['cash', 'mobile_money_manual', 'bank_transfer'] })
		.array()
		.notNull()
		.default(['cash', 'mobile_money_manual', 'bank_transfer']),
	verifiedAt: tstz('verified_at'),
	suspendedAt: tstz('suspended_at'),
	suspendedReason: text('suspended_reason'),
	logoId: uuid('logo_id'),
	createdBy: uuid('created_by').notNull(),
	createdAt: tstz('created_at').notNull().defaultNow(),
	updatedAt: tstz('updated_at').notNull().defaultNow()
});

export const organizationMembers = pgTable('organization_members', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	userId: uuid('user_id').notNull(),
	role: text('role', { enum: ['director', 'manager', 'field_agent', 'viewer'] }).notNull(),
	status: text('status', { enum: ['active', 'removed'] }).notNull(),
	invitedBy: uuid('invited_by'),
	joinedAt: tstz('joined_at').notNull().defaultNow(),
	removedAt: tstz('removed_at'),
	removedBy: uuid('removed_by'),
	/** Nom affiché, recopié de `users.name` : l'équipe se synchronise sans répliquer `users` (D30). */
	displayName: text('display_name').notNull().default(''),
	createdAt: tstz('created_at').notNull().defaultNow(),
	updatedAt: tstz('updated_at').notNull().defaultNow()
});

export const organizationInvitations = pgTable('organization_invitations', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	phone: text('phone').notNull(),
	role: text('role', { enum: ['director', 'manager', 'field_agent', 'viewer'] }).notNull(),
	tokenHash: bytea('token_hash').notNull().unique(),
	invitedBy: uuid('invited_by').notNull(),
	expiresAt: tstz('expires_at').notNull(),
	acceptedAt: tstz('accepted_at'),
	acceptedBy: uuid('accepted_by'),
	revokedAt: tstz('revoked_at'),
	revokedBy: uuid('revoked_by'),
	createdAt: tstz('created_at').notNull().defaultNow()
});

export const organizationLogos = pgTable('organization_logos', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	originalKey: text('original_key').notNull(),
	originalMime: text('original_mime', { enum: ['image/png', 'image/jpeg', 'image/webp'] }).notNull(),
	originalBytes: integer('original_bytes').notNull(),
	status: text('status', { enum: ['processing', 'ready', 'failed'] }).notNull(),
	webKey: text('web_key'),
	printKey: text('print_key'),
	width: integer('width'),
	height: integer('height'),
	error: text('error'),
	createdBy: uuid('created_by').notNull(),
	createdAt: tstz('created_at').notNull().defaultNow(),
	processedAt: tstz('processed_at')
});

export const auditLog = pgTable('audit_log', {
	id: uuid('id').primaryKey(),
	occurredAt: tstz('occurred_at').notNull().defaultNow(),
	actorType: text('actor_type', { enum: ['user', 'system'] }).notNull(),
	actorUserId: uuid('actor_user_id'),
	actorRole: text('actor_role'),
	organizationId: uuid('organization_id'),
	subjectUserId: uuid('subject_user_id'),
	action: text('action').notNull(),
	objectType: text('object_type').notNull(),
	objectId: uuid('object_id'),
	before: jsonb('before'),
	after: jsonb('after'),
	origin: text('origin', { enum: ['app', 'api', 'admin', 'sync', 'job'] }).notNull(),
	ip: inet('ip'),
	requestId: text('request_id')
});
