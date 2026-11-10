/**
 * Registre des documents privés (lot 07, D22) : types, statuts et matrice de confidentialité par type
 * (docs/UX.md §10). Une organisation peut restreindre un document, jamais élargir la matrice ; une autre
 * organisation n'y a jamais accès ; le profil lecture ne voit aucun document privé. Le lot 08 bis ajoute les types du
 * bail (contrat, avenant, pièce d'identité du locataire…), le lot 10 bis l'état des lieux.
 */
import { z } from 'zod';
import { idSchema } from './ids.js';
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
	'other'
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** `pending` : fiche créée, fichier pas encore reçu et vérifié ; `rejected` : fichier refusé (taille, type). */
export const DOCUMENT_STATUSES = ['pending', 'active', 'replaced', 'withdrawn', 'rejected'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** Restriction posée par l'organisation : elle ne fait que réduire les droits de la matrice. */
export const DOCUMENT_RESTRICTIONS = ['director_only'] as const;
export type DocumentRestriction = (typeof DOCUMENT_RESTRICTIONS)[number];

/** Objets auxquels un document se rattache au lot 07 (bail, contrat, locataire : lot 08 bis). */
export const DOCUMENT_SUBJECTS = ['owner', 'mandate', 'property', 'unit'] as const;
export type DocumentSubject = (typeof DOCUMENT_SUBJECTS)[number];

/** Pièces privées : mêmes limites de taille que les photos ; PDF ou image. */
export const DOCUMENT_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] as const;
export type DocumentMimeType = (typeof DOCUMENT_MIME_TYPES)[number];

/** Durée d'une URL signée de lecture d'un document (prompt du lot 07). */
export const DOCUMENT_URL_TTL_SECONDS = 5 * 60;

type StaffRole = Extract<OrganizationRole, 'director' | 'manager'>;

export interface DocumentAccessRule {
	/** Membres de l'organisation qui lisent ce type (le profil lecture, jamais). */
	staff: readonly StaffRole[];
	/** Agent de terrain : jamais, ou sur ses unités affectées (état des lieux, lot 10 bis). */
	fieldAgent: 'never' | 'assigned_units';
	/** Espaces personnels (lot 10 ter) : le propriétaire voit les siens ; le locataire, les siens. */
	owner: 'never' | 'own';
	tenant: 'never' | 'own';
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
	other: { staff: STAFF, fieldAgent: 'never', owner: 'never', tenant: 'never' }
};

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

// ---------------------------------------------------------------- schémas et vues (lot 07, étape 3)

/**
 * Dépôt d'un document (en ligne seulement) : le serveur décide la clé, signe le type et la taille ; la nouvelle
 * version d'un document en remplace une autre (même type, mêmes objets).
 */
export const createDocumentSchema = z
	.object({
		id: idSchema,
		type: z.enum(DOCUMENT_TYPES),
		ownerId: idSchema.nullish().transform((v) => v ?? null),
		mandateId: idSchema.nullish().transform((v) => v ?? null),
		propertyId: idSchema.nullish().transform((v) => v ?? null),
		unitId: idSchema.nullish().transform((v) => v ?? null),
		replacesId: idSchema.nullish().transform((v) => v ?? null),
		fileName: z
			.string()
			.trim()
			.min(1, { error: 'Nom du fichier manquant.' })
			.max(200, { error: 'Nom du fichier trop long.' })
			.refine((v) => !v.includes('/') && !v.includes('\\') && ![...v].some((c) => c.charCodeAt(0) < 32), {
				error: 'Nom du fichier invalide.'
			}),
		mimeType: z.enum(DOCUMENT_MIME_TYPES, { error: 'Format refusé : PDF, JPEG, PNG, WebP ou HEIC.' }),
		byteSize: z.number().int().min(1, { error: 'Fichier vide.' }).max(MAX_UPLOAD_BYTES, { error: 'Document trop lourd : 10 Mo au plus.' }),
		restriction: z
			.enum(DOCUMENT_RESTRICTIONS)
			.nullish()
			.transform((v) => v ?? null)
	})
	.superRefine((d, ctx) => {
		if (!d.ownerId && !d.mandateId && !d.propertyId && !d.unitId) {
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
