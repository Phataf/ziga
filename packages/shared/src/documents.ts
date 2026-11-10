/**
 * Registre des documents privés (lot 07, D22) : types, statuts et matrice de confidentialité par type
 * (docs/UX.md §10). Une organisation peut restreindre un document, jamais élargir la matrice ; une autre
 * organisation n'y a jamais accès ; le profil lecture ne voit aucun document privé. Le lot 08 bis ajoute les types du
 * bail (contrat, avenant, pièce d'identité du locataire…), le lot 10 bis l'état des lieux.
 */
import type { OrganizationRole } from './permissions.js';

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
