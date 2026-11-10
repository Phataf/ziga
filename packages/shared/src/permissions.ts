/**
 * Rôles et matrice de permissions des organisations (lot 03) : source unique, lue par l'API (garde @Can)
 * et par l'interface (qui masque ce qui est interdit). Un interrupteur actif n'accorde jamais une permission
 * que le rôle n'a pas (CLAUDE.md §8). Les lots suivants complètent la matrice.
 */
export const ORGANIZATION_TYPES = ['agency', 'landlord'] as const;
export type OrganizationType = (typeof ORGANIZATION_TYPES)[number];

export const ORGANIZATION_ROLES = ['director', 'manager', 'field_agent', 'viewer'] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const MEMBER_STATUSES = ['active', 'removed'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export const VERIFICATION_STATUSES = ['pending', 'verified', 'suspended'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

const D = 'director';
const M = 'manager';
const F = 'field_agent';
const V = 'viewer';

/** Action nommée → rôles autorisés. */
export const PERMISSIONS = {
	// Lot 03 : organisation, équipe, journal (chacune a son endpoint).
	'organization.read': [D, M, F, V],
	'organization.update': [D],
	'member.read': [D, M],
	'member.invite': [D],
	'member.change_role': [D],
	'member.remove': [D],
	'invitation.revoke': [D],
	'audit.read': [D],
	// Lot 06 : propriétaires et mandats. L'agent de terrain et le profil lecture consultent seulement.
	'owner.read': [D, M, F, V],
	'owner.create': [D, M],
	'owner.update': [D, M],
	'mandate.read': [D, M, F, V],
	'mandate.create': [D, M],
	'mandate.update': [D, M],
	'mandate.revoke': [D, M],
	// Lot 07 : biens, unités, photos et documents. L'agent de terrain ne lit que ses unités affectées (Sync Streams et
	// API) et n'y change que l'état technique et les photos ; le profil lecture ne voit aucun document privé.
	'property.read': [D, M, F, V],
	'property.manage': [D, M],
	'unit.assign': [D, M],
	'unit.status': [D, M, F],
	'document.read': [D, M],
	'document.upload': [D, M],
	'document.withdraw': [D, M],
	// Restreindre un document à la direction (jamais élargir la matrice, docs/UX.md §10).
	'document.restrict': [D],
	// Déclarées dès le lot 03 pour fixer le partage des rôles ; leurs endpoints viennent avec leur lot.
	'lease.manage': [D, M],
	'payment.record': [D, M],
	// Agent de terrain : espèces « à valider », sur ses unités affectées.
	'payment.record_cash': [D, M, F],
	'payment.validate': [D, M],
	'receipt.cancel': [D],
	'reminder.send': [D, M],
	'listing.publish': [D, M],
	'lead.manage': [D, M, F],
	'visit.manage': [D, M, F],
	'photo.upload': [D, M, F],
	// Sous l'interrupteur exports.csv (lot 04) en plus du rôle.
	'export.csv': [D, V],
	'settings.update': [D]
} as const satisfies Record<string, readonly OrganizationRole[]>;

export type Action = keyof typeof PERMISSIONS;
export const ACTIONS = Object.keys(PERMISSIONS) as Action[];

export function can(role: OrganizationRole | null | undefined, action: Action): boolean {
	return !!role && (PERMISSIONS[action] as readonly string[]).includes(role);
}

/** Rôles qu'un directeur peut attribuer par invitation ou changement de rôle. */
export const ASSIGNABLE_ROLES: readonly OrganizationRole[] = ORGANIZATION_ROLES;

/** Profil de navigation d'un membre (docs/UX.md §2) : un bailleur particulier a sa propre navigation. */
export type MemberProfile = OrganizationRole | 'landlord';

export function memberProfile(type: OrganizationType, role: OrganizationRole): MemberProfile {
	return type === 'landlord' ? 'landlord' : role;
}

// ---------------------------------------------------------------- rôles de la plateforme (lot 04)

export const PLATFORM_ROLE_KEYS = ['super_admin', 'support', 'sales', 'finance'] as const;
export type PlatformRoleKey = (typeof PLATFORM_ROLE_KEYS)[number];

const SA = 'super_admin';
const SU = 'support';
const SL = 'sales';
const FI = 'finance';

/**
 * Back-office : chaque rôle n'accède qu'à sa partie (prompt du lot 04). Seul `super_admin` modifie les interrupteurs.
 * Vérifié par le garde @PlatformCan de l'API ; l'interface masque le reste.
 */
export const PLATFORM_PERMISSIONS = {
	/** Lire organisations, personnes, simulateur et journal de la plateforme. */
	'platform.read': [SA, SU, SL, FI],
	'organization.verify': [SA, SU],
	'organization.suspend': [SA],
	'support.access': [SA, SU],
	'organization.change_plan': [SA, SL],
	/** Prix et quotas des formules (hypothèses du cadrage). */
	'plan.manage': [SA, SL],
	'subscription.manage': [SA, SL],
	'subscription.record_payment': [SA, FI],
	/** Modes globaux, exceptions, formules incluses, exceptions de quota. */
	'feature.manage': [SA],
	/** Référentiel géographique (lot 07) : ajouter un quartier, corriger un point, le marquer vérifié. */
	'geography.manage': [SA, SU]
} as const satisfies Record<string, readonly PlatformRoleKey[]>;

export type PlatformAction = keyof typeof PLATFORM_PERMISSIONS;
export const PLATFORM_ACTIONS = Object.keys(PLATFORM_PERMISSIONS) as PlatformAction[];

export function platformCan(role: string | null | undefined, action: PlatformAction): boolean {
	return !!role && (PLATFORM_PERMISSIONS[action] as readonly string[]).includes(role);
}

export const PLATFORM_ROLE_LABELS: Record<PlatformRoleKey, string> = {
	super_admin: 'Administrateur général',
	support: 'Assistance',
	sales: 'Commercial',
	finance: 'Finances'
};
