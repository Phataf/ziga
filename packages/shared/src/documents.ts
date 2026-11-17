/**
 * Registre des documents privés (lot 07, D22) : types, statuts et matrice de confidentialité par type
 * (docs/UX.md §10). Une organisation peut restreindre un document, jamais élargir la matrice ; une autre
 * organisation n'y a jamais accès ; le profil lecture ne voit aucun document privé. Le lot 08 bis ajoute les types du
 * bail (contrat, avenant, pièce d'identité du locataire…), le lot 10 bis l'état des lieux.
 */
import { z } from 'zod';
import { idSchema } from './ids.js';
import type { ContractStatus } from './contracts.js';
import type { OrganizationRole } from './permissions.js';
import { MAX_UPLOAD_BYTES } from './properties.js';

export const DOCUMENT_TYPES = [
	'title_deed', // titre foncier
	'puh', // permis urbain d'habiter
	'allocation_certificate', // attestation d'attribution
	'apfr', // attestation de possession foncière rurale
	'owner_identity', // pièce d'identité du propriétaire
	'mandate', // mandat de gestion
	'document_photo', // photo d'un document
	'other',
	// Lot 08 : bail signé scanné (rattaché au bail), pièce d'identité du locataire (rattachée au locataire).
	'signed_lease_scan',
	'tenant_identity',
	// Lot 08 bis : modèle Word de l'organisation, projets de contrat (Word et PDF générés par le serveur), avenant signé
	// scanné, preuves de légalisation et d'enregistrement (rattachés au contrat et au bail).
	'contract_template',
	'contract_draft',
	'signed_amendment_scan',
	'contract_legalization',
	'contract_registration',
	// Lot 10 : justificatif d'une dépense (facture, reçu du prestataire), rattaché au bien ou à l'unité.
	'expense_receipt'
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** Documents du contrat (lot 08 bis) : déposés ou générés par les routes du contrat, jamais par la route générique. */
export const CONTRACT_DOCUMENT_TYPES = [
	'contract_template',
	'contract_draft',
	'signed_amendment_scan',
	'contract_legalization',
	'contract_registration'
] as const satisfies readonly DocumentType[];

/** `pending` : fiche créée, fichier pas encore reçu et vérifié ; `rejected` : fichier refusé (taille, type). */
export const DOCUMENT_STATUSES = ['pending', 'active', 'replaced', 'withdrawn', 'rejected'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** Restriction posée par l'organisation : elle ne fait que réduire les droits de la matrice. */
export const DOCUMENT_RESTRICTIONS = ['director_only'] as const;
export type DocumentRestriction = (typeof DOCUMENT_RESTRICTIONS)[number];

/** Objets auxquels un document se rattache : lot 07, puis bail et locataire (lot 08), contrat et modèle (lot 08 bis). */
export const DOCUMENT_SUBJECTS = [
	'owner',
	'mandate',
	'property',
	'unit',
	'tenant',
	'lease',
	'lease_contract',
	'contract_template'
] as const;
export type DocumentSubject = (typeof DOCUMENT_SUBJECTS)[number];

/** Pièces déposées par la route générique : mêmes limites de taille que les photos ; PDF ou image. */
export const UPLOAD_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] as const;
export type UploadMimeType = (typeof UPLOAD_MIME_TYPES)[number];

/** Formats enregistrés : ceux du dépôt, plus le Word d'un modèle ou d'un projet de contrat (lot 08 bis). */
export const DOCUMENT_MIME_TYPES = [
	...UPLOAD_MIME_TYPES,
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
] as const;
export type DocumentMimeType = (typeof DOCUMENT_MIME_TYPES)[number];

/** Durée d'une URL signée de lecture d'un document (prompt du lot 07). */
export const DOCUMENT_URL_TTL_SECONDS = 5 * 60;

type StaffRole = Extract<OrganizationRole, 'director' | 'manager'>;

export interface DocumentAccessRule {
	/** Membres de l'organisation qui lisent ce type (le profil lecture, jamais). */
	staff: readonly StaffRole[];
	/** Agent de terrain : jamais, ou sur ses unités affectées (état des lieux, lot 10 bis). */
	fieldAgent: 'never' | 'assigned_units';
	/**
	 * Espaces personnels (lot 10 ter) : le propriétaire voit les siens ; le locataire, les siens. `own_from_ready_to_sign` :
	 * le projet de contrat, seulement à partir de « prêt à signer » (docs/UX.md §10, lot 08 bis).
	 */
	owner: 'never' | 'own';
	tenant: 'never' | 'own' | 'own_from_ready_to_sign';
}

const STAFF = ['director', 'manager'] as const;

/** Matrice de docs/UX.md §10, pour les types du lot 07. */
export const DOCUMENT_ACCESS: Record<DocumentType, DocumentAccessRule> = {
	title_deed: { staff: STAFF, fieldAgent: 'never', owner: 'own', tenant: 'never' },
	puh: { staff: STAFF, fieldAgent: 'never', owner: 'own', tenant: 'never' },
	allocation_certificate: { staff: STAFF, fieldAgent: 'never', owner: 'own', tenant: 'never' },
	apfr: { staff: STAFF, fieldAgent: 'never', owner: 'own', tenant: 'never' },
	owner_identity: { staff: STAFF, fieldAgent: 'never', owner: 'own', tenant: 'never' },
	mandate: { staff: STAFF, fieldAgent: 'never', owner: 'own', tenant: 'never' },
	// Hors matrice : traités comme des notes internes, la règle la plus étroite (direction et gestion seulement).
	document_photo: { staff: STAFF, fieldAgent: 'never', owner: 'never', tenant: 'never' },
	other: { staff: STAFF, fieldAgent: 'never', owner: 'never', tenant: 'never' },
	// Lot 08 : « Contrat signé » et « Pièce d'identité du locataire » de la matrice.
	signed_lease_scan: { staff: STAFF, fieldAgent: 'never', owner: 'own', tenant: 'own' },
	tenant_identity: { staff: STAFF, fieldAgent: 'never', owner: 'never', tenant: 'own' },
	// Lot 08 bis. « Modèle de contrat » : l'organisation seule (la direction le modifie, permission à part).
	contract_template: { staff: STAFF, fieldAgent: 'never', owner: 'never', tenant: 'never' },
	// « Projet de contrat » : le locataire à partir de « prêt à signer » ; le propriétaire si son accord est requis, ce
	// qui viendra en P2 (validation par le propriétaire) : jamais d'ici là.
	contract_draft: { staff: STAFF, fieldAgent: 'never', owner: 'never', tenant: 'own_from_ready_to_sign' },
	// « Contrat signé, annexes, avenants » : comme le bail signé.
	signed_amendment_scan: { staff: STAFF, fieldAgent: 'never', owner: 'own', tenant: 'own' },
	contract_legalization: { staff: STAFF, fieldAgent: 'never', owner: 'own', tenant: 'own' },
	contract_registration: { staff: STAFF, fieldAgent: 'never', owner: 'own', tenant: 'own' },
	// Lot 10 : comme « Justificatifs retenus sur la caution » de la matrice ; le locataire ne verra que ceux des dépenses
	// qui lui sont réclamées (lot 10 ter).
	expense_receipt: { staff: STAFF, fieldAgent: 'never', owner: 'own', tenant: 'own' }
};

/** Documents du bail : rattachés au bail ou au locataire (module leases, lot 08). */
export const LEASE_DOCUMENT_TYPES = ['signed_lease_scan', 'tenant_identity'] as const satisfies readonly DocumentType[];

export interface DocumentForAccess {
	type: DocumentType;
	restriction: DocumentRestriction | null;
}

/**
 * Un membre de l'organisation peut-il lire ce document ? Matrice du type, puis restriction de l'organisation (qui ne
 * fait que réduire). `assignedUnit` : le document concerne une unité affectée à cet agent de terrain.
 */
export function canReadDocument(
	role: OrganizationRole | null | undefined,
	doc: DocumentForAccess,
	context: { assignedUnit?: boolean } = {}
): boolean {
	if (!role || role === 'viewer') return false;
	const rule = DOCUMENT_ACCESS[doc.type];
	const allowed =
		role === 'field_agent'
			? rule.fieldAgent === 'assigned_units' && context.assignedUnit === true
			: (rule.staff as readonly string[]).includes(role);
	if (!allowed) return false;
	if (doc.restriction === 'director_only') return role === 'director';
	return true;
}

export type DocumentParty = 'owner' | 'tenant';

/**
 * Le propriétaire ou le locataire peut-il lire ce document, dans son espace personnel (lot 10 ter) ? Seulement s'il en
 * est partie (`isParty` : c'est son bail, son bien, sa pièce), selon la matrice du type ; une restriction posée par
 * l'organisation retire aussi l'accès des parties. Un projet de contrat n'est lu par le locataire qu'à partir de
 * « prêt à signer ». Une autre organisation n'a jamais accès : ce n'est pas une partie.
 */
export function canPartyReadDocument(
	party: DocumentParty,
	doc: DocumentForAccess,
	context: { isParty: boolean; contractStatus?: ContractStatus | null }
): boolean {
	if (!context.isParty || doc.restriction) return false;
	const rule = DOCUMENT_ACCESS[doc.type][party];
	if (rule === 'never') return false;
	if (rule === 'own_from_ready_to_sign') return context.contractStatus === 'ready_to_sign' || context.contractStatus === 'signed';
	return true;
}

// ---------------------------------------------------------------- schémas et vues (lot 07, étape 3)

/**
 * Dépôt d'un document (en ligne seulement) : le serveur décide la clé, signe le type et la taille ; la nouvelle
 * version d'un document en remplace une autre (même type, mêmes objets).
 */
export const createDocumentSchema = z
	.object({
		id: idSchema,
		// Les documents du contrat passent par les routes du contrat (lot 08 bis), jamais par celle-ci.
		type: z.enum(DOCUMENT_TYPES).refine((t) => !(CONTRACT_DOCUMENT_TYPES as readonly string[]).includes(t), {
			error: 'Ce document se dépose depuis le contrat.'
		}),
		ownerId: idSchema.nullish().transform((v) => v ?? null),
		mandateId: idSchema.nullish().transform((v) => v ?? null),
		propertyId: idSchema.nullish().transform((v) => v ?? null),
		unitId: idSchema.nullish().transform((v) => v ?? null),
		tenantId: idSchema.nullish().transform((v) => v ?? null),
		leaseId: idSchema.nullish().transform((v) => v ?? null),
		replacesId: idSchema.nullish().transform((v) => v ?? null),
		fileName: z
			.string()
			.trim()
			.min(1, { error: 'Nom du fichier manquant.' })
			.max(200, { error: 'Nom du fichier trop long.' })
			.refine((v) => !v.includes('/') && !v.includes('\\') && ![...v].some((c) => c.charCodeAt(0) < 32), {
				error: 'Nom du fichier invalide.'
			}),
		mimeType: z.enum(UPLOAD_MIME_TYPES, { error: 'Format refusé : PDF, JPEG, PNG, WebP ou HEIC.' }),
		byteSize: z.number().int().min(1, { error: 'Fichier vide.' }).max(MAX_UPLOAD_BYTES, { error: 'Document trop lourd : 10 Mo au plus.' }),
		restriction: z
			.enum(DOCUMENT_RESTRICTIONS)
			.nullish()
			.transform((v) => v ?? null)
	})
	.superRefine((d, ctx) => {
		// Lot 08 : le bail scanné se rattache à un bail, la pièce d'identité du locataire à un locataire.
		if (d.type === 'signed_lease_scan' && !d.leaseId) {
			ctx.addIssue({ code: 'custom', path: ['leaseId'], message: 'Rattachez le bail scanné à son bail.' });
		}
		if (d.type === 'tenant_identity' && !d.tenantId) {
			ctx.addIssue({ code: 'custom', path: ['tenantId'], message: 'Rattachez la pièce d’identité à son locataire.' });
		}
		if (!d.ownerId && !d.mandateId && !d.propertyId && !d.unitId && !d.tenantId && !d.leaseId) {
			ctx.addIssue({ code: 'custom', path: ['propertyId'], message: 'Rattachez le document à un propriétaire, un mandat ou un bien.' });
		}
		if (d.unitId && !d.propertyId) ctx.addIssue({ code: 'custom', path: ['propertyId'], message: 'Indiquez le bien de l’unité.' });
	});
export type CreateDocumentInput = z.input<typeof createDocumentSchema>;
export type CreateDocumentData = z.output<typeof createDocumentSchema>;

export const withdrawDocumentSchema = z.object({
	reason: z.string().trim().min(5, { error: 'Indiquez le motif du retrait (5 caractères au moins).' }).max(500)
});

export const restrictDocumentSchema = z.object({ restriction: z.enum(DOCUMENT_RESTRICTIONS).nullable() });

export interface DocumentView {
	id: string;
	type: DocumentType;
	ownerId: string | null;
	mandateId: string | null;
	propertyId: string | null;
	unitId: string | null;
	tenantId: string | null;
	leaseId: string | null;
	leaseContractId: string | null;
	contractTemplateId: string | null;
	version: number;
	replacesId: string | null;
	fileName: string;
	mimeType: DocumentMimeType;
	byteSize: number;
	sha256: string | null;
	status: DocumentStatus;
	restriction: DocumentRestriction | null;
	error: string | null;
	uploadedBy: string;
	createdAt: string;
	activatedAt: string | null;
	replacedAt: string | null;
	withdrawnAt: string | null;
	withdrawalReason: string | null;
}

/** Lecture d'un document : une URL signée de 5 minutes, jamais derrière le CDN public. */
export interface DocumentDownload {
	url: string;
	expiresAt: string;
}
