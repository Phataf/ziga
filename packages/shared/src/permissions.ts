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
	// Déclarées dès le lot 03 pour fixer le partage des rôles ; leurs endpoints viennent avec leur lot.
	'property.manage': [D, M],
	'lease.manage': [D, M],
	'payment.record': [D, M],
	// Agent de terrain : espèces « à valider », sur ses biens affectés (restriction ajoutée au lot 07).
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
