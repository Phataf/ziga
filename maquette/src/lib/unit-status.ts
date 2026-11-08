/**
 * Statut d'une unité en quatre dimensions (D14, CLAUDE.md règle 13).
 * - fiche : brouillon, active, archivée (saisie) ;
 * - occupation : libre, réservée, louée, en préavis — CALCULÉE à partir des baux, jamais saisie ;
 * - état technique : prête, à remettre en état, en travaux, indisponible (saisi) ;
 * - annonce : non publiée, publiée, suspendue (l'annonce suit la disponibilité).
 * Fonctions pures, sans état ; elles préfigurent packages/shared.
 */
import type { BadgeVariant } from './components/ui/badge';
import { formatDate } from './format';
import type { Dataset, Lease, ListingState, Occupancy, RecordState, TechnicalState, Unit, UnitStatus } from './types';

export interface OccupancyResult {
	occupancy: Occupancy;
	/** Bail en cours (louée, en préavis) ou bail signé à venir (réservée). */
	lease?: Lease;
	/** Libre à partir de cette date (préavis). */
	until?: string;
	/** Entrée du locataire à cette date (réservée). */
	from?: string;
}

/** Un bail est en cours s'il a commencé et que les clés n'ont pas été rendues. */
export function isLeaseCurrent(lease: Lease, today: string): boolean {
	return lease.startDate <= today && !(lease.endDate && lease.endDate <= today);
}

export function isLeaseEnded(lease: Lease, today: string): boolean {
	return !!lease.endDate && lease.endDate <= today;
}

/** Occupation d'une unité, déduite des baux : on ne la saisit jamais. */
export function occupancyOf(unitId: string, leases: Lease[], today: string): OccupancyResult {
	const mine = leases.filter((l) => l.unitId === unitId);
	const current = mine.find((l) => isLeaseCurrent(l, today));
	if (current) {
		return current.notice
			? { occupancy: 'notice', lease: current, until: current.notice.effectiveDate }
			: { occupancy: 'occupied', lease: current };
	}
	const next = mine.filter((l) => l.startDate > today).sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
	if (next) return { occupancy: 'reserved', lease: next, from: next.startDate };
	return { occupancy: 'free' };
}

/** Statut simplifié du lot 00 (libre, louée, réservée), gardé pour les écrans qui l'utilisent. */
export function legacyStatus(occupancy: Occupancy): UnitStatus {
	if (occupancy === 'occupied' || occupancy === 'notice') return 'rented';
	return occupancy;
}

export interface UnitDimensions {
	record: RecordState;
	occupancy: Occupancy;
	technical: TechnicalState;
}

export function dimensionsOf(unit: Pick<Unit, 'record' | 'occupancy' | 'technical' | 'status'>): UnitDimensions {
	const fallback: Occupancy = unit.status === 'rented' ? 'occupied' : unit.status === 'reserved' ? 'reserved' : 'free';
	return {
		record: unit.record ?? 'active',
		occupancy: unit.occupancy ?? fallback,
		technical: unit.technical ?? 'ready'
	};
}

/** Disponible = fiche active, libre ou en préavis, et prête. C'est un résultat, pas une saisie. */
export function isAvailable(d: UnitDimensions): boolean {
	return d.record === 'active' && (d.occupancy === 'free' || d.occupancy === 'notice') && d.technical === 'ready';
}

/** L'annonce suit la disponibilité : une annonce publiée d'une unité non disponible est suspendue. */
export function listingStateOf(unit: Pick<Unit, 'visibility' | 'record' | 'occupancy' | 'technical' | 'status'>): ListingState {
	if (unit.visibility !== 'published') return 'unpublished';
	return isAvailable(dimensionsOf(unit)) ? 'published' : 'suspended';
}

export const recordLabel: Record<RecordState, string> = { draft: 'Brouillon', active: 'Fiche active', archived: 'Archivée' };
export const occupancyLabel: Record<Occupancy, string> = { free: 'Libre', reserved: 'Réservée', occupied: 'Louée', notice: 'En préavis' };
export const technicalLabel: Record<TechnicalState, string> = {
	ready: 'Prête',
	to_refurbish: 'À remettre en état',
	works: 'En travaux',
	unavailable: 'Indisponible'
};
export const listingLabel: Record<ListingState, string> = { unpublished: 'Non publiée', published: 'Publiée', suspended: 'Annonce suspendue' };

export const occupancyVariant: Record<Occupancy, BadgeVariant> = { free: 'info', reserved: 'warning', occupied: 'success', notice: 'warning' };
export const technicalVariant: Record<TechnicalState, BadgeVariant> = { ready: 'success', to_refurbish: 'warning', works: 'warning', unavailable: 'outline' };

export interface UnitSummary {
	label: string;
	variant: BadgeVariant;
	available: boolean;
}

/**
 * Pastille de synthèse des cartes et des tableaux (docs/UX.md §10) :
 * « Disponible », « Louée », « En préavis, libre le jj/mm/aaaa », « À remettre en état »…
 */
export function unitSummary(d: UnitDimensions, dates: { until?: string; from?: string } = {}): UnitSummary {
	const available = isAvailable(d);
	if (d.record === 'draft') return { label: 'Brouillon', variant: 'outline', available };
	if (d.record === 'archived') return { label: 'Archivée', variant: 'outline', available };
	if (d.occupancy === 'occupied') return { label: 'Louée', variant: 'success', available };
	if (d.occupancy === 'notice') {
		const label = dates.until ? `En préavis, libre le ${formatDate(dates.until)}` : 'En préavis';
		return { label, variant: 'warning', available };
	}
	if (d.occupancy === 'reserved') {
		return { label: dates.from ? `Réservée, entrée le ${formatDate(dates.from)}` : 'Réservée', variant: 'warning', available };
	}
	if (d.technical !== 'ready') return { label: technicalLabel[d.technical], variant: technicalVariant[d.technical], available };
	return { label: 'Disponible', variant: 'info', available };
}

/** Tous les baux connus de l'organisation : en cours, terminés et signés à venir. */
export function allLeases(data: Pick<Dataset, 'leases' | 'upcomingLeases'>): Lease[] {
	return [...data.leases, ...(data.upcomingLeases ?? [])];
}

/** Recalcule l'occupation (et le statut simplifié) de chaque unité à partir des baux. */
export function withUnitStatus<T extends Pick<Dataset, 'units' | 'leases' | 'upcomingLeases' | 'today'>>(data: T): T {
	const leases = allLeases(data);
	return {
		...data,
		units: data.units.map((u) => {
			const { occupancy } = occupancyOf(u.id, leases, data.today);
			return { ...u, occupancy, status: legacyStatus(occupancy), record: u.record ?? 'active', technical: u.technical ?? 'ready' };
		})
	};
}

/** Pastille de synthèse d'une unité dans son jeu de données. */
export function summaryOfUnit(data: Pick<Dataset, 'leases' | 'upcomingLeases' | 'today'>, unit: Unit): UnitSummary & OccupancyResult {
	const occ = occupancyOf(unit.id, allLeases(data), data.today);
	const d = { ...dimensionsOf(unit), occupancy: occ.occupancy };
	return { ...occ, ...unitSummary(d, occ) };
}

/** Comptes par pastille de synthèse (sans les dates), pour les listes et la synthèse du parc. */
export function summaryCounts(data: Pick<Dataset, 'leases' | 'upcomingLeases' | 'today'>, units: Unit[]): { label: string; variant: BadgeVariant; count: number }[] {
	const order = ['Disponible', 'Louée', 'En préavis', 'Réservée', 'À remettre en état', 'En travaux', 'Indisponible', 'Brouillon', 'Archivée'];
	const map = new Map<string, { label: string; variant: BadgeVariant; count: number }>();
	for (const u of units) {
		const s = summaryOfUnit(data, u);
		const label = s.label.startsWith('En préavis') ? 'En préavis' : s.label.startsWith('Réservée') ? 'Réservée' : s.label;
		const cur = map.get(label) ?? { label, variant: s.variant, count: 0 };
		cur.count++;
		map.set(label, cur);
	}
	return [...map.values()].sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
}
