/**
 * Section « Compte lié » d'une fiche (lot 10 ter, étape 3) : où en est la liaison et quelles actions proposer. Règle
 * pure (CLAUDE.md §6 : pas de logique dans les composants), à partir des liens de la fiche lus en ligne
 * (`GET /person-links`), du plus récent au plus ancien.
 */
import type { MyPersonLinkView, PersonLinkView } from '@ziga/shared/person-links';

export type LinkStateKind = 'none' | 'invited' | 'invite_expired' | 'claimed' | 'requested_unverified' | 'requested_verified' | 'active';

export interface LinkState {
	kind: LinkStateKind;
	/** Le lien en cours (non révoqué), s'il y en a un. */
	link: PersonLinkView | null;
	canInvite: boolean;
	/** « Renvoyer l'invitation » : invitation en attente jamais ouverte (perdue ou expirée). */
	canResend: boolean;
	canAccept: boolean;
	canRevoke: boolean;
}

export function linkState(links: readonly PersonLinkView[], now = new Date()): LinkState {
	const link = links.find((l) => l.status !== 'revoked') ?? null;
	const base = { link, canInvite: false, canResend: false, canAccept: false, canRevoke: !!link };
	if (!link) return { ...base, kind: 'none', canInvite: true };
	if (link.status === 'active') return { ...base, kind: 'active' };
	if (link.origin === 'organization_invite') {
		if (link.claimed) return { ...base, kind: 'claimed' };
		const expired = !!link.inviteExpiresAt && new Date(link.inviteExpiresAt).getTime() <= now.getTime();
		return { ...base, kind: expired ? 'invite_expired' : 'invited', canResend: true };
	}
	return { ...base, kind: link.phoneVerified ? 'requested_verified' : 'requested_unverified', canAccept: !link.accepted };
}

// ---------------------------------------------------------------- signalements (fiche du bail, lus sur l'appareil)

export interface LocalMaintenanceRequest {
	id: string;
	leaseId: string;
	title: string;
	description: string;
	status: 'received' | 'planned' | 'done';
	plannedOn: string | null;
	statusNote: string | null;
	createdAt: string;
}

/** Ligne SQLite de `maintenance_requests` (synchronisée sans la personne qui signale) → vue de la fiche du bail. */
export function toMaintenanceRequest(r: Record<string, unknown>): LocalMaintenanceRequest {
	const status = r.status === 'planned' || r.status === 'done' ? r.status : 'received';
	return {
		id: String(r.id),
		leaseId: String(r.lease_id),
		title: String(r.title ?? ''),
		description: String(r.description ?? ''),
		status,
		plannedOn: typeof r.planned_on === 'string' && r.planned_on ? r.planned_on : null,
		statusNote: typeof r.status_note === 'string' && r.status_note ? r.status_note : null,
		createdAt: String(r.created_at ?? '')
	};
}

/** Un lien vu par la personne, dans son espace (« Mes fiches liées ») : ce qu'il lui reste à faire. */
export type MyLinkStep = 'active' | 'enter_code' | 'awaiting_organization';

export function myLinkStep(link: Pick<MyPersonLinkView, 'status' | 'phoneVerified'>): MyLinkStep {
	if (link.status === 'active') return 'active';
	return link.phoneVerified ? 'awaiting_organization' : 'enter_code';
}

/** Les espaces personnels proposés dans le choix de l'espace : ceux que le serveur ouvre ; hors ligne, les deux. */
export function personalSpaces(spaces: { owner: boolean; tenant: boolean } | null, failed: boolean): ('owner' | 'tenant')[] {
	if (failed) return ['owner', 'tenant'];
	if (!spaces) return [];
	return (['owner', 'tenant'] as const).filter((s) => spaces[s]);
}
