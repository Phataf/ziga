/**
 * Locataires, baux, échéances et comptes de caution (lot 08). La migration SQL (0013) fait foi : RLS, clés
 * composites, règle 8 (index uniques partiels), versions du bail et statut des cautions tenus par la base, mouvements
 * en ajout seul. Lu et écrit par le seul module leases (règle ESLint d'import, CLAUDE.md §4) ; pas exporté par l'index
 * du schéma. L'occupation d'une unité n'est pas une colonne : elle se calcule à partir des baux (packages/shared).
 */
import { bigint, boolean, date, integer, jsonb, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { AmendmentType, ContractData, ContractFieldValue, ContractTemplateKind, TemplateTagUsage } from '@ziga/shared/contract-fields';
import type {
	AmendmentStatus,
	ContractOrigin,
	ContractParty,
	ContractStatus,
	ContractTemplateSource,
	ContractTemplateStatus,
	SignatureMode
} from '@ziga/shared/contracts';
import type {
	DepositAccountStatus,
	DepositHolder,
	DepositMovementType,
	DepositType,
	LeaseStatus,
	RentDueStatus
} from '@ziga/shared/leases';
import type { RentBillingMode, RentPeriodicity } from '@ziga/shared/rent-schedule';

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const day = (name: string) => date(name, { mode: 'string' });
const fcfa = (name: string) => bigint(name, { mode: 'number' });

export const tenants = pgTable('tenants', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	civility: text('civility', { enum: ['mr', 'mrs', 'miss'] }),
	fullName: text('full_name').notNull(),
	phone: text('phone'),
	secondaryPhone: text('secondary_phone'),
	nationality: text('nationality'),
	profession: text('profession'),
	previousAddress: text('previous_address'),
	emergencyContactName: text('emergency_contact_name'),
	emergencyContactPhone: text('emergency_contact_phone'),
	notes: text('notes'),
	// État civil et pièce d'identité : directeur et gestionnaire seulement.
	birthDate: day('birth_date'),
	birthPlace: text('birth_place'),
	idType: text('id_type', { enum: ['cnib', 'passport', 'consular_card', 'residence_card', 'other'] }),
	idTypeOther: text('id_type_other'),
	idNumber: text('id_number'),
	idIssuedOn: day('id_issued_on'),
	idIssuedBy: text('id_issued_by'),
	userId: uuid('user_id'),
	status: text('status', { enum: ['active', 'archived'] }).notNull(),
	archivedAt: tstz('archived_at'),
	createdBy: uuid('created_by'),
	createdAt: tstz('created_at').notNull().defaultNow(),
	updatedAt: tstz('updated_at').notNull().defaultNow()
});

export const leases = pgTable('leases', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	unitId: uuid('unit_id').notNull(),
	tenantId: uuid('tenant_id').notNull(),
	startsOn: day('starts_on').notNull(),
	endsOn: day('ends_on'),
	durationMonths: smallint('duration_months'),
	duesStartOn: day('dues_start_on').notNull(),
	rent: fcfa('rent').notNull(),
	charges: fcfa('charges').notNull(),
	rentEffectiveFrom: day('rent_effective_from').notNull(),
	periodicity: text('periodicity').$type<RentPeriodicity>().notNull(),
	dueDay: smallint('due_day').notNull(),
	billingMode: text('billing_mode').$type<RentBillingMode>().notNull(),
	advanceMonths: smallint('advance_months').notNull(),
	lessorType: text('lessor_type', { enum: ['owner', 'organization'] }).notNull(),
	paymentTerms: text('payment_terms'),
	penaltyRateBp: integer('penalty_rate_bp'),
	penaltyGraceDays: smallint('penalty_grace_days'),
	penaltyBeneficiary: text('penalty_beneficiary', { enum: ['organization', 'owner'] }),
	noticeTenantFixedTermMonths: smallint('notice_tenant_fixed_term_months').notNull(),
	noticeTenantOpenEndedMonths: smallint('notice_tenant_open_ended_months').notNull(),
	noticeLessorFixedTermMonths: smallint('notice_lessor_fixed_term_months').notNull(),
	noticeLessorOpenEndedMonths: smallint('notice_lessor_open_ended_months').notNull(),
	reducedNoticeMonths: smallint('reduced_notice_months'),
	reducedNoticeCases: text('reduced_notice_cases'),
	earlyTerminationIndemnityMonths: smallint('early_termination_indemnity_months'),
	renewalMode: text('renewal_mode', { enum: ['open_ended', 'same_duration'] }).notNull(),
	depositRefundDays: smallint('deposit_refund_days').notNull(),
	status: text('status').$type<LeaseStatus>().notNull(),
	activatedOn: day('activated_on'),
	activatedAt: tstz('activated_at'),
	cancelledAt: tstz('cancelled_at'),
	cancellationReason: text('cancellation_reason'),
	noticeGivenOn: day('notice_given_on'),
	exitOn: day('exit_on'),
	endedAt: tstz('ended_at'),
	endReason: text('end_reason'),
	version: integer('version').notNull(),
	// Lot 08 bis : dernier renouvellement (avenant signé, ou reconduction au terme sans congé).
	lastRenewedOn: day('last_renewed_on'),
	lastRenewalAutomatic: boolean('last_renewal_automatic').notNull().default(false),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	createdAt: tstz('created_at').notNull().defaultNow(),
	updatedAt: tstz('updated_at').notNull().defaultNow()
});

/** Écrite par la base seule (trigger) : l'application la lit, jamais ne l'écrit. */
export const leaseVersions = pgTable('lease_versions', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	leaseId: uuid('lease_id').notNull(),
	version: integer('version').notNull(),
	rent: fcfa('rent').notNull(),
	charges: fcfa('charges').notNull(),
	rentEffectiveFrom: day('rent_effective_from').notNull(),
	startsOn: day('starts_on').notNull(),
	endsOn: day('ends_on'),
	duesStartOn: day('dues_start_on').notNull(),
	dueDay: smallint('due_day').notNull(),
	billingMode: text('billing_mode').$type<RentBillingMode>().notNull(),
	periodicity: text('periodicity').$type<RentPeriodicity>().notNull(),
	advanceMonths: smallint('advance_months').notNull(),
	status: text('status').$type<LeaseStatus>().notNull(),
	changedBy: uuid('changed_by'),
	recordedAt: tstz('recorded_at').notNull()
});

/** Écrites par le serveur seul (validation du bail, tâche quotidienne). */
export const rentDues = pgTable('rent_dues', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	leaseId: uuid('lease_id').notNull(),
	periodStart: day('period_start').notNull(),
	periodEnd: day('period_end').notNull(),
	dueOn: day('due_on').notNull(),
	rent: fcfa('rent').notNull(),
	charges: fcfa('charges').notNull(),
	amountDue: fcfa('amount_due').notNull(),
	amountPaid: fcfa('amount_paid').notNull(),
	status: text('status').$type<RentDueStatus>().notNull(),
	prorated: boolean('prorated').notNull(),
	isAdvance: boolean('is_advance').notNull(),
	leaseVersion: integer('lease_version').notNull(),
	createdAt: tstz('created_at').notNull().defaultNow(),
	updatedAt: tstz('updated_at').notNull().defaultNow()
});

/** Statut et détenteur : écrits par la base à partir des mouvements. */
export const depositAccounts = pgTable('deposit_accounts', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	leaseId: uuid('lease_id').notNull(),
	type: text('type').$type<DepositType>().notNull(),
	agreedAmount: fcfa('agreed_amount').notNull(),
	agreedMonths: smallint('agreed_months'),
	holder: text('holder').$type<DepositHolder>().notNull(),
	status: text('status').$type<DepositAccountStatus>().notNull(),
	createdBy: uuid('created_by'),
	createdAt: tstz('created_at').notNull().defaultNow(),
	updatedAt: tstz('updated_at').notNull().defaultNow()
});

/** Ajout seul (trigger). */
export const depositMovements = pgTable('deposit_movements', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	accountId: uuid('account_id').notNull(),
	type: text('type').$type<DepositMovementType>().notNull(),
	amount: fcfa('amount').notNull(),
	previousHolder: text('previous_holder').$type<DepositHolder>(),
	newHolder: text('new_holder').$type<DepositHolder>(),
	reason: text('reason'),
	occurredOn: day('occurred_on').notNull(),
	documentId: uuid('document_id'),
	agreementId: uuid('agreement_id'),
	inspectionItemId: uuid('inspection_item_id'),
	paymentId: uuid('payment_id'),
	createdBy: uuid('created_by'),
	createdAt: tstz('created_at').notNull().defaultNow()
});

// ---------------------------------------------------------------- lot 08 bis : contrats (migration 0014)

export const contractTemplates = pgTable('contract_templates', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	kind: text('kind').$type<ContractTemplateKind>().notNull(),
	name: text('name').notNull(),
	version: integer('version').notNull(),
	replacesId: uuid('replaces_id'),
	documentId: uuid('document_id').notNull(),
	status: text('status').$type<ContractTemplateStatus>().notNull(),
	inspectedAt: tstz('inspected_at'),
	inspectionError: text('inspection_error'),
	detectedFields: text('detected_fields').array().notNull(),
	unknownFields: text('unknown_fields').array().notNull(),
	tagUsages: jsonb('tag_usages').$type<TemplateTagUsage[]>().notNull(),
	fonts: text('fonts').array().notNull(),
	unmatchedFonts: text('unmatched_fonts').array().notNull(),
	pageCount: integer('page_count'),
	activatedAt: tstz('activated_at'),
	activatedBy: uuid('activated_by'),
	retiredAt: tstz('retired_at'),
	createdBy: uuid('created_by').notNull(),
	createdAt: tstz('created_at').notNull().defaultNow(),
	updatedAt: tstz('updated_at').notNull().defaultNow()
});

export const leaseAmendments = pgTable('lease_amendments', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	leaseId: uuid('lease_id').notNull(),
	number: integer('number').notNull(),
	type: text('type').$type<AmendmentType>().notNull(),
	effectiveFrom: day('effective_from').notNull(),
	newRent: fcfa('new_rent'),
	newCharges: fcfa('new_charges'),
	newEndsOn: day('new_ends_on'),
	openEnded: boolean('open_ended').notNull(),
	description: text('description'),
	expectedLeaseVersion: integer('expected_lease_version').notNull(),
	status: text('status').$type<AmendmentStatus>().notNull(),
	appliedAt: tstz('applied_at'),
	appliedLeaseVersion: integer('applied_lease_version'),
	cancelledAt: tstz('cancelled_at'),
	cancellationReason: text('cancellation_reason'),
	createdBy: uuid('created_by').notNull(),
	createdAt: tstz('created_at').notNull().defaultNow(),
	updatedAt: tstz('updated_at').notNull().defaultNow()
});

export const leaseContracts = pgTable('lease_contracts', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	leaseId: uuid('lease_id').notNull(),
	amendmentId: uuid('amendment_id'),
	origin: text('origin').$type<ContractOrigin>().notNull(),
	templateSource: text('template_source').$type<ContractTemplateSource>(),
	templateId: uuid('template_id'),
	templateVersion: integer('template_version'),
	status: text('status').$type<ContractStatus>().notNull(),
	currentVersion: integer('current_version').notNull(),
	frozenVersion: integer('frozen_version'),
	frozenAt: tstz('frozen_at'),
	frozenBy: uuid('frozen_by'),
	generationStatus: text('generation_status', { enum: ['idle', 'pending', 'failed'] }).notNull(),
	generationError: text('generation_error'),
	signingPlace: text('signing_place'),
	signingDate: day('signing_date'),
	copies: smallint('copies'),
	expectedSigners: text('expected_signers').array().$type<ContractParty[]>(),
	organizationSignedOn: day('organization_signed_on'),
	ownerSignedOn: day('owner_signed_on'),
	tenantSignedOn: day('tenant_signed_on'),
	signatureMode: text('signature_mode').$type<SignatureMode>(),
	signedDocumentId: uuid('signed_document_id'),
	signatureRecordedBy: uuid('signature_recorded_by'),
	signatureRecordedAt: tstz('signature_recorded_at'),
	legalizedOn: day('legalized_on'),
	legalizationCommune: text('legalization_commune'),
	legalizationReference: text('legalization_reference'),
	legalizationDocumentId: uuid('legalization_document_id'),
	registeredOn: day('registered_on'),
	registrationReference: text('registration_reference'),
	registrationDocumentId: uuid('registration_document_id'),
	legalizationReminder: boolean('legalization_reminder').notNull(),
	createdBy: uuid('created_by'),
	createdAt: tstz('created_at').notNull().defaultNow(),
	updatedAt: tstz('updated_at').notNull().defaultNow()
});

/** Versions des contrats : ajout seul (trigger), jamais modifiées ni supprimées. */
export const contractVersions = pgTable('contract_versions', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	contractId: uuid('contract_id').notNull(),
	number: integer('number').notNull(),
	leaseVersion: integer('lease_version').notNull(),
	templateSource: text('template_source').$type<ContractTemplateSource>().notNull(),
	templateId: uuid('template_id'),
	templateVersion: integer('template_version').notNull(),
	data: jsonb('data').$type<ContractData>().notNull(),
	fields: jsonb('fields').$type<Record<string, ContractFieldValue>>().notNull(),
	blankFields: text('blank_fields').array().notNull(),
	warnings: text('warnings').array().notNull(),
	docxDocumentId: uuid('docx_document_id').notNull(),
	pdfDocumentId: uuid('pdf_document_id').notNull(),
	docxSha256: text('docx_sha256').notNull(),
	pdfSha256: text('pdf_sha256').notNull(),
	pageCount: integer('page_count'),
	createdBy: uuid('created_by'),
	createdAt: tstz('created_at').notNull().defaultNow()
});
