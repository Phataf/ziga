/**
 * Lot 10 ter : liaison d'une fiche (propriétaire ou locataire) d'une organisation au compte d'une personne, et
 * signalements. Règles pures, appliquées par l'API (étape 2) et, en dernier rempart, par la base (migration 0022).
 * Règle 15 de CLAUDE.md, D13, D17 ; réponses du porteur au plan (22/11/2026).
 *
 * - Un lien naît demandé ; il devient actif quand le numéro de la fiche, celui du compte et celui qui a reçu le code
 *   sont le même (point b) et qu'un membre de la direction ou de la gestion l'a accepté ; révoqué, il ne change plus.
 * - La personne ne demande une liaison qu'à une agence vérifiée ; un bailleur particulier invite (réponse 1).
 * - La propre fiche d'un bailleur particulier se lie à son compte, s'il en est le directeur et si le numéro vérifié du
 *   compte est celui de la fiche (réponse 2).
 * - Un changement de numéro (fiche ou compte) révoque le lien ; la liaison est à refaire (réponse 3).
 * - Le propriétaire voit le nom du locataire, jamais son téléphone ni sa pièce d'identité, sauf dans le contrat signé et
 *   ses avenants (réponse 5, précision du porteur sur D22).
 */
import { z } from 'zod';
import { otpCodeSchema } from './auth.js';
import { isIsoDate } from './dates.js';
import { idSchema } from './ids.js';
import type { OrganizationType, VerificationStatus } from './permissions.js';

export const PERSON_LINK_STATUSES = ['requested', 'active', 'revoked'] as const;
export type PersonLinkStatus = (typeof PERSON_LINK_STATUSES)[number];

export const PERSON_LINK_RECORD_TYPES = ['owner', 'tenant'] as const;
export type PersonLinkRecordType = (typeof PERSON_LINK_RECORD_TYPES)[number];

/** Invitation depuis la fiche, demande depuis l'espace de la personne, propre fiche d'un bailleur particulier. */
export const PERSON_LINK_ORIGINS = ['organization_invite', 'person_request', 'landlord_self'] as const;
export type PersonLinkOrigin = (typeof PERSON_LINK_ORIGINS)[number];

/** Qui révoque : l'organisation, la personne, ou la base (changement de numéro). */
export const PERSON_LINK_REVOKERS = ['organization', 'person', 'system'] as const;
export type PersonLinkRevoker = (typeof PERSON_LINK_REVOKERS)[number];

/** Motifs écrits par la base quand un numéro change (migration 0022, mêmes textes). */
export const PHONE_CHANGE_REVOCATION = {
	record_phone_changed: 'Numéro de la fiche modifié : la liaison est à refaire.',
	account_phone_changed: 'Numéro du compte modifié : la liaison est à refaire.'
} as const;
export type PhoneChangeCause = keyof typeof PHONE_CHANGE_REVOCATION;

export function personLinkTransitionAllowed(from: PersonLinkStatus, to: PersonLinkStatus): boolean {
	return (from === 'requested' && (to === 'active' || to === 'revoked')) || (from === 'active' && to === 'revoked');
}

export type LinkPhoneBlocker = 'LINK_RECORD_NO_PHONE' | 'LINK_PHONE_MISMATCH' | 'LINK_ACCOUNT_UNVERIFIED';

/**
 * Le numéro de la fiche est celui du compte, et le compte est vérifié (point b du porteur). Les numéros sont en E.164 :
 * la comparaison est exacte. Une fiche sans numéro ne se lie pas : l'organisation le renseigne d'abord.
 */
export function linkPhoneBlocker(input: {
	recordPhone: string | null;
	accountPhone: string;
	accountPhoneVerified: boolean;
}): LinkPhoneBlocker | null {
	if (!input.recordPhone) return 'LINK_RECORD_NO_PHONE';
	if (input.recordPhone !== input.accountPhone) return 'LINK_PHONE_MISMATCH';
	if (!input.accountPhoneVerified) return 'LINK_ACCOUNT_UNVERIFIED';
	return null;
}

export type ActivationBlocker = LinkPhoneBlocker | 'LINK_NOT_REQUESTED' | 'LINK_CODE_MISSING' | 'LINK_NOT_ACCEPTED';

/** Un lien demandé devient actif avec le code validé et l'acceptation de l'organisation ; jamais l'un sans l'autre. */
export function activationBlocker(input: {
	status: PersonLinkStatus;
	phoneVerified: boolean;
	accepted: boolean;
	recordPhone: string | null;
	linkPhone: string;
	accountPhone: string;
	accountPhoneVerified: boolean;
}): ActivationBlocker | null {
	if (input.status !== 'requested') return 'LINK_NOT_REQUESTED';
	if (input.recordPhone !== input.linkPhone) return input.recordPhone ? 'LINK_PHONE_MISMATCH' : 'LINK_RECORD_NO_PHONE';
	const phone = linkPhoneBlocker(input);
	if (phone) return phone;
	if (!input.phoneVerified) return 'LINK_CODE_MISSING';
	if (!input.accepted) return 'LINK_NOT_ACCEPTED';
	return null;
}

/** Réponse 1 : la personne ne demande une liaison qu'à une agence vérifiée ; un bailleur particulier invite. */
export function canRequestLinkFrom(org: { type: OrganizationType; verificationStatus: VerificationStatus }): boolean {
	return org.type === 'agency' && org.verificationStatus === 'verified';
}

/**
 * Limites des demandes de liaison par la personne (réponse 1) : par compte et par numéro, sur 24 heures. La réponse est
 * la même que la fiche existe ou non : seules ces limites empêchent de deviner les fiches d'une agence.
 */
export const LINK_REQUEST_LIMITS = { perUser: 5, perPhone: 5, windowSeconds: 24 * 60 * 60 } as const;

/** Réponse 2 : la propre fiche d'un bailleur particulier se lie sans code ni acceptation, à ces conditions seulement. */
export function landlordSelfLinkEligible(input: {
	organizationType: OrganizationType;
	isDirector: boolean;
	isSelfRecord: boolean;
	recordPhone: string | null;
	accountPhone: string;
	accountPhoneVerified: boolean;
}): boolean {
	return (
		input.organizationType === 'landlord' &&
		input.isDirector &&
		input.isSelfRecord &&
		linkPhoneBlocker({
			recordPhone: input.recordPhone,
			accountPhone: input.accountPhone,
			accountPhoneVerified: input.accountPhoneVerified
		}) === null
	);
}

export interface ActivePersonLink {
	linkId: string;
	organizationId: string;
	recordType: PersonLinkRecordType;
	recordId: string;
}

/**
 * Empreinte de l'ensemble des liens actifs d'une personne : la clé du cache court du module portals la contient, si
 * bien qu'une révocation (l'ensemble change) ne retrouve jamais une lecture en cache (point d). Indépendante de l'ordre.
 */
export function linkSetFingerprint(links: readonly ActivePersonLink[]): string {
	return links
		.map((l) => `${l.organizationId}:${l.recordType}:${l.recordId}:${l.linkId}`)
		.sort()
		.join('|');
}

// ---------------------------------------------------------------- ce que le propriétaire voit d'un locataire

/** Réponse 5 et point c : du locataire, le propriétaire ne reçoit que son nom (et sa civilité). */
export interface OwnerVisibleTenant {
	fullName: string;
	civility: 'mr' | 'mrs' | 'miss' | null;
}

export function ownerVisibleTenant(tenant: { fullName: string; civility?: 'mr' | 'mrs' | 'miss' | null }): OwnerVisibleTenant {
	return { fullName: tenant.fullName, civility: tenant.civility ?? null };
}

/**
 * Champs d'une fiche locataire que l'espace propriétaire ne contient jamais (point c) : téléphones, état civil, pièce
 * d'identité, contact d'urgence, adresse précédente, notes. Seuls le contrat signé et ses avenants les portent (D22).
 */
export const TENANT_FIELDS_HIDDEN_FROM_OWNER = [
	'phone',
	'secondaryPhone',
	'birthDate',
	'birthPlace',
	'idType',
	'idTypeOther',
	'idNumber',
	'idIssuedOn',
	'idIssuedBy',
	'emergencyContactName',
	'emergencyContactPhone',
	'previousAddress',
	'notes'
] as const;

// ---------------------------------------------------------------- signalements (réponse 4)

export const MAINTENANCE_REQUEST_STATUSES = ['received', 'planned', 'done'] as const;
export type MaintenanceRequestStatus = (typeof MAINTENANCE_REQUEST_STATUSES)[number];

export function maintenanceTransitionAllowed(from: MaintenanceRequestStatus, to: MaintenanceRequestStatus): boolean {
	return (from === 'received' && (to === 'planned' || to === 'done')) || (from === 'planned' && to === 'done');
}

/** Un signalement vise un bail en vigueur ou en préavis. */
export function canReportOnLease(leaseStatus: string): boolean {
	return leaseStatus === 'active' || leaseStatus === 'notice';
}

// ---------------------------------------------------------------- schémas des routes (étape 2), réutilisés par les formulaires

const reason = z.string().trim().min(5, { error: 'Motif trop court (5 caractères au moins).' }).max(500, { error: 'Motif trop long.' });

/** Durée de validité du lien d'invitation envoyé par WhatsApp ou SMS au numéro de la fiche. */
export const PERSON_LINK_INVITE_TTL_DAYS = 7;

/** L'organisation invite la personne depuis sa fiche : le lien part au numéro de la fiche (WhatsApp, ou SMS par le serveur). */
export const invitePersonLinkSchema = z.object({
	id: idSchema,
	recordType: z.enum(PERSON_LINK_RECORD_TYPES),
	recordId: idSchema,
	sendSms: z.boolean().default(false)
});

/** La personne demande la liaison depuis son espace : une agence vérifiée, un type de fiche. */
export const requestPersonLinkSchema = z.object({
	id: idSchema,
	organizationId: idSchema,
	recordType: z.enum(PERSON_LINK_RECORD_TYPES)
});

/** Code reçu au numéro de la fiche, pour un lien d'une organisation. */
export const verifyPersonLinkSchema = z.object({ organizationId: idSchema, code: otpCodeSchema });

/** Nouveau code, pour un lien d'une organisation. */
export const personLinkActionSchema = z.object({ organizationId: idSchema });

/** Révocation par l'organisation (motif obligatoire). */
export const revokePersonLinkSchema = z.object({ reason });

/** Révocation par la personne, depuis son espace (motif obligatoire). */
export const personRevokeLinkSchema = z.object({ organizationId: idSchema, reason });

// ---------------------------------------------------------------- vues (étape 2)

/** Lien vu par l'organisation, sur la fiche (section « Compte lié ») : jamais le compte lui-même. */
export interface PersonLinkView {
	id: string;
	recordType: PersonLinkRecordType;
	recordId: string;
	status: PersonLinkStatus;
	origin: PersonLinkOrigin;
	phoneVerified: boolean;
	accepted: boolean;
	/** Invitation réclamée par une personne (son compte au numéro de la fiche). */
	claimed: boolean;
	inviteExpiresAt: string | null;
	createdAt: string;
	acceptedAt: string | null;
	revokedAt: string | null;
	revokedByParty: PersonLinkRevoker | null;
	revocationReason: string | null;
}

/** Lien vu par la personne, dans son espace : l'organisation, le type de fiche, où en est la liaison. */
export interface MyPersonLinkView {
	id: string;
	organizationId: string;
	organizationName: string;
	recordType: PersonLinkRecordType;
	status: Exclude<PersonLinkStatus, 'revoked'>;
	phoneVerified: boolean;
	accepted: boolean;
	createdAt: string;
}

/** Agence proposée à une demande de liaison (réponse 1) : le nom seulement. */
export interface LinkRequestOrganization {
	id: string;
	name: string;
}

/** Invitation vue avant de se connecter (lien reçu par WhatsApp ou SMS) : le numéro masqué, jamais la fiche. */
export interface PersonLinkInvitationPreview {
	organizationName: string;
	recordType: PersonLinkRecordType;
	phone: string;
	expiresAt: string;
	usable: boolean;
}

export const createMaintenanceRequestSchema = z.object({
	id: idSchema,
	leaseId: idSchema,
	title: z.string().trim().min(3, { error: 'Titre trop court.' }).max(120, { error: 'Titre trop long.' }),
	description: z
		.string()
		.trim()
		.min(5, { error: 'Décrivez le problème (5 caractères au moins).' })
		.max(2000, { error: 'Description trop longue.' })
});

export const updateMaintenanceRequestSchema = z
	.object({
		status: z.enum(MAINTENANCE_REQUEST_STATUSES),
		plannedOn: z
			.string()
			.refine(isIsoDate, { error: 'Date invalide.' })
			.nullish()
			.transform((v) => v ?? null),
		statusNote: z
			.string()
			.trim()
			.max(500, { error: 'Mot trop long.' })
			.nullish()
			.transform((v) => (v ? v : null))
	})
	.refine((v) => v.status !== 'planned' || v.plannedOn !== null, { error: 'Date de passage prévue obligatoire.', path: ['plannedOn'] });
