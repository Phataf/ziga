/**
 * Propriétaires et mandats lus dans la base locale (lot 06) : lignes SQLite (booléens en 0 ou 1, colonnes en
 * snake_case) transformées en vues des écrans, les mêmes que celles de l'API. Recherche et alertes : sur l'appareil,
 * sans appel réseau. Fonctions pures, testées.
 */
import {
	commissionFromColumns,
	effectiveMandateStatus,
	mandateAlert,
	type CommissionColumns,
	type EffectiveMandateStatus,
	type MandateType,
	type MandateView,
	type MandateVersionView,
	type OwnerView
} from '@ziga/shared/owners';

type Row = Record<string, unknown>;

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const bool = (v: unknown) => v === 1 || v === true || v === '1';
const int = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export function toOwner(r: Row): OwnerView {
	const repName = str(r.representative_name);
	const repPhone = str(r.representative_phone);
	return {
		id: String(r.id),
		type: String(r.type) as OwnerView['type'],
		name: String(r.name ?? ''),
		phone: String(r.phone ?? ''),
		email: str(r.email),
		address: str(r.address),
		country: String(r.country ?? 'BF'),
		representative: repName && repPhone ? { name: repName, phone: repPhone } : null,
		notes: str(r.notes),
		// Une fiche créée sur l'appareil n'a pas encore de statut renvoyé par le serveur : elle est active.
		status: r.status === 'archived' ? 'archived' : 'active',
		archivedAt: str(r.archived_at),
		createdAt: str(r.created_at) ?? '',
		updatedAt: str(r.updated_at) ?? ''
	};
}

function terms(r: Row) {
	return {
		startsOn: String(r.starts_on ?? ''),
		endsOn: str(r.ends_on),
		commission: commissionFromColumns({
			commission_basis: str(r.commission_basis) as CommissionColumns['commission_basis'],
			commission_rate_bp: int(r.commission_rate_bp),
			commission_amount: int(r.commission_amount)
		}),
		canPublish: bool(r.can_publish),
		canTakePhotos: bool(r.can_take_photos),
		canCollectFunds: bool(r.can_collect_funds),
		canSignLeases: bool(r.can_sign_leases),
		exclusive: bool(r.exclusive)
	};
}

export function toMandate(r: Row): MandateView {
	return {
		id: String(r.id),
		ownerId: String(r.owner_id),
		type: String(r.type) as MandateType,
		...terms(r),
		status: (str(r.status) ?? 'active') as MandateView['status'],
		revokedAt: str(r.revoked_at),
		revocationReason: str(r.revocation_reason),
		expiredAt: str(r.expired_at),
		version: int(r.version) ?? 1,
		createdAt: str(r.created_at) ?? '',
		updatedAt: str(r.updated_at) ?? ''
	};
}

export function toVersion(r: Row): MandateVersionView {
	return {
		mandateId: String(r.mandate_id),
		version: int(r.version) ?? 1,
		...terms(r),
		status: (str(r.status) ?? 'active') as MandateVersionView['status'],
		revokedAt: str(r.revoked_at),
		revocationReason: str(r.revocation_reason),
		expiredAt: str(r.expired_at),
		changedBy: str(r.changed_by),
		recordedAt: str(r.recorded_at) ?? ''
	};
}

/** Minuscules sans accents, pour chercher « ouedraogo » dans « Ouédraogo ». */
export function normalize(text: string): string {
	return text
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '')
		.toLowerCase()
		.trim();
}

/** Recherche sur le nom (sans accents) et sur les chiffres du téléphone ; une recherche vide garde tout. */
export function searchOwners<T extends Pick<OwnerView, 'name' | 'phone'>>(owners: T[], query: string): T[] {
	const q = normalize(query);
	if (!q) return owners;
	const digits = q.replace(/\D/g, '');
	return owners.filter((o) => normalize(o.name).includes(q) || (digits.length >= 2 && o.phone.replace(/\D/g, '').includes(digits)));
}

/** Mandat en vigueur d'un propriétaire, le plus récent d'abord (gestion avant les autres). */
export function currentMandate<T extends Pick<MandateView, 'status' | 'startsOn' | 'endsOn' | 'type'>>(
	mandates: T[],
	today: string
): T | null {
	const inForce = mandates.filter((m) => effectiveMandateStatus(m, today) === 'active');
	return (
		inForce.find((m) => m.type === 'rental_management' || m.type === 'self_managed') ??
		inForce[0] ??
		mandates.find((m) => effectiveMandateStatus(m, today) === 'upcoming') ??
		null
	);
}

export interface ExpiringMandate {
	mandateId: string;
	ownerId: string;
	endsOn: string;
	daysLeft: number;
}

/** Mandats en vigueur qui finissent dans 30 jours ou moins, les plus proches d'abord. */
export function expiringMandates(
	mandates: Pick<MandateView, 'id' | 'ownerId' | 'status' | 'startsOn' | 'endsOn'>[],
	today: string
): ExpiringMandate[] {
	return mandates
		.flatMap((m) => {
			const alert = mandateAlert(m, today);
			return alert && m.endsOn ? [{ mandateId: m.id, ownerId: m.ownerId, endsOn: m.endsOn, daysLeft: alert.daysLeft }] : [];
		})
		.sort((a, b) => a.daysLeft - b.daysLeft);
}

/** Statut effectif d'un mandat, pour le badge. */
export function badgeOf(m: Pick<MandateView, 'status' | 'startsOn' | 'endsOn'>, today: string): EffectiveMandateStatus {
	return effectiveMandateStatus(m, today);
}
