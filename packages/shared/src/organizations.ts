/**
 * Schémas des organisations (lot 03), partagés par l'API et les formulaires : création, paramètres
 * (fiche, identifiants, représentant légal, D24), invitations, logo, et « Mon compte ».
 */
import { z } from 'zod';
import { passwordSchema, personNameSchema } from './auth.js';
import { isIsoDate } from './dates.js';
import { idSchema } from './ids.js';
import { ORGANIZATION_ROLES, ORGANIZATION_TYPES } from './permissions.js';
import { phoneSchema } from './phone.js';

/** Pièces d'identité du représentant légal ; « Autre » demande de préciser. */
export const ID_DOCUMENT_TYPES = ['cnib', 'passport', 'consular_card', 'residence_card', 'other'] as const;
export type IdDocumentType = (typeof ID_DOCUMENT_TYPES)[number];
export const ID_DOCUMENT_LABELS: Record<IdDocumentType, string> = {
	cnib: 'CNIB',
	passport: 'Passeport',
	consular_card: 'Carte consulaire',
	residence_card: 'Carte de résident',
	other: 'Autre'
};

const text = (max: number, message = 'Champ trop long.') => z.string().trim().max(max, { error: message });
/** Texte facultatif : une chaîne vide vaut « non renseigné » (null). */
const optionalText = (max: number) =>
	text(max)
		.nullish()
		.transform((v) => (v ? v : null));

export const organizationNameSchema = z
	.string()
	.trim()
	.min(2, { error: 'Indiquez le nom.' })
	.max(120, { error: 'Nom trop long (120 caractères au plus).' });

const isoDate = z
	.string()
	.refine(isIsoDate, { error: 'Date invalide.' })
	.nullish()
	.transform((v) => v ?? null);

/** Identifiants d'entreprise : majuscules, espaces simples ; la forme exacte n'est pas imposée (D24). */
const registryNumber = (max: number) =>
	z
		.string()
		.trim()
		.max(max, { error: 'Identifiant trop long.' })
		.transform((v) => v.replace(/\s+/g, ' ').toUpperCase())
		.nullish()
		.transform((v) => (v ? v : null));

export const createOrganizationSchema = z.object({
	/** Identifiant généré par le client (UUIDv7, CLAUDE.md §6). */
	id: idSchema,
	type: z.enum(ORGANIZATION_TYPES),
	legalName: organizationNameSchema,
	phone: phoneSchema,
	commune: text(80).min(2, { error: 'Indiquez la commune.' })
});
export type CreateOrganizationInput = z.input<typeof createOrganizationSchema>;

export const representativeSchema = z
	.object({
		name: optionalText(120),
		title: optionalText(80),
		profession: optionalText(80),
		address: optionalText(200),
		nationality: optionalText(60),
		idType: z
			.enum(ID_DOCUMENT_TYPES)
			.nullish()
			.transform((v) => v ?? null),
		idTypeOther: optionalText(60),
		idNumber: optionalText(40),
		idIssuedOn: isoDate,
		idIssuedBy: optionalText(120)
	})
	.superRefine((r, ctx) => {
		if (r.idType === 'other' && !r.idTypeOther) {
			ctx.addIssue({ code: 'custom', path: ['idTypeOther'], message: 'Précisez le type de pièce.' });
		}
	})
	.transform((r) => ({ ...r, idTypeOther: r.idType === 'other' ? r.idTypeOther : null }));
export type Representative = z.output<typeof representativeSchema>;

export const updateOrganizationSchema = z
	.object({
		legalName: organizationNameSchema,
		tradeName: optionalText(120),
		phone: phoneSchema,
		address: optionalText(200),
		commune: text(80).min(2, { error: 'Indiquez la commune.' }),
		poBox: optionalText(60),
		rccm: registryNumber(40),
		ifu: registryNumber(20),
		representative: representativeSchema
	})
	.partial();
export type UpdateOrganizationInput = z.input<typeof updateOrganizationSchema>;
/** Paramètres validés et normalisés (sortie du schéma) : ce que le serveur enregistre. */
export type UpdateOrganizationOutput = z.output<typeof updateOrganizationSchema>;

export const inviteMemberSchema = z.object({ phone: phoneSchema, role: z.enum(ORGANIZATION_ROLES) });
export const changeRoleSchema = z.object({ role: z.enum(ORGANIZATION_ROLES) });

/** Invitation valable 7 jours, usage unique. */
export const INVITATION_TTL_DAYS = 7;

/** Logo : PNG, JPEG ou WebP, 2 Mo au plus ; SVG refusé (scripts possibles). */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type LogoMimeType = (typeof LOGO_MIME_TYPES)[number];

/** Moyens de paiement acceptés (D18) : un réglage de l'organisation, jamais un interrupteur ; au moins un actif. */
export const PAYMENT_METHODS = ['cash', 'mobile_money_manual', 'bank_transfer'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
	cash: 'Espèces',
	mobile_money_manual: 'Mobile Money (saisi avec sa référence)',
	bank_transfer: 'Virement bancaire'
};
export const paymentMethodsSchema = z.object({
	methods: z
		.array(z.enum(PAYMENT_METHODS))
		.min(1, { error: 'Gardez au moins un moyen de paiement accepté.' })
		.transform((m) => PAYMENT_METHODS.filter((x) => m.includes(x)))
});

/** Le directeur ne peut que désactiver, pour son organisation, une fonctionnalité qui lui est ouverte. */
export const organizationFeatureSettingSchema = z.object({ disabled: z.boolean() });

// « Mon compte » (complément c du lot 03).
export const updateProfileSchema = z.object({ name: personNameSchema });
export const changePasswordSchema = z.object({
	currentPassword: z.string().min(1, { error: 'Indiquez votre mot de passe actuel.' }).max(128),
	newPassword: passwordSchema
});
export const changePhoneSchema = z.object({
	phone: phoneSchema,
	password: z.string().min(1, { error: 'Indiquez votre mot de passe.' }).max(128)
});
export const confirmPhoneSchema = z.object({
	phone: phoneSchema,
	code: z.string().regex(/^\d{6}$/, { error: 'Le code contient 6 chiffres.' })
});

/** Vues renvoyées par l'API. */
export interface MembershipView {
	organizationId: string;
	type: (typeof ORGANIZATION_TYPES)[number];
	name: string;
	role: (typeof ORGANIZATION_ROLES)[number];
	verificationStatus: 'pending' | 'verified' | 'suspended';
}

export interface LogoView {
	id: string;
	status: 'processing' | 'ready' | 'failed';
	webUrl: string | null;
	pdfUrl: string | null;
}

export interface OrganizationView {
	id: string;
	type: (typeof ORGANIZATION_TYPES)[number];
	legalName: string;
	tradeName: string | null;
	phone: string;
	address: string | null;
	commune: string;
	poBox: string | null;
	rccm: string | null;
	ifu: string | null;
	representative: Representative;
	verificationStatus: 'pending' | 'verified' | 'suspended';
	logo: LogoView | null;
	planId: string;
	acceptedPaymentMethods: PaymentMethod[];
	createdAt: string;
	updatedAt: string;
}

export interface MemberView {
	id: string;
	userId: string;
	name: string;
	phone: string;
	role: (typeof ORGANIZATION_ROLES)[number];
	status: 'active' | 'removed';
	joinedAt: string;
	current: boolean;
}

export interface InvitationView {
	id: string;
	phone: string;
	role: (typeof ORGANIZATION_ROLES)[number];
	invitedBy: string;
	expiresAt: string;
	createdAt: string;
}

/** Invitation vue par la personne invitée, avant acceptation. */
export interface InvitationPreview {
	organizationName: string;
	organizationType: (typeof ORGANIZATION_TYPES)[number];
	role: (typeof ORGANIZATION_ROLES)[number];
	invitedBy: string;
	phone: string;
	expiresAt: string;
}

export interface AuditEntryView {
	id: string;
	occurredAt: string;
	actorName: string | null;
	actorRole: string | null;
	action: string;
	objectType: string;
	objectId: string | null;
	before: unknown;
	after: unknown;
	origin: string;
	/**
	 * Identifiant de la requête qui a écrit la ligne (en-tête `x-request-id`) : les lignes écrites par un même
	 * envoi, par exemple les opérations d'un même lot de synchronisation, portent le même.
	 */
	requestId: string | null;
	/** Organisation et personne concernées (journal du back-office). */
	organizationId?: string | null;
	subjectUserId?: string | null;
}

export const ROLE_LABELS: Record<(typeof ORGANIZATION_ROLES)[number], string> = {
	director: 'Directeur',
	manager: 'Gestionnaire',
	field_agent: 'Agent de terrain',
	viewer: 'Lecture et comptabilité'
};
