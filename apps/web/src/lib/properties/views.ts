/**
 * Biens, unités et photos lus dans la base locale (lot 07) : lignes SQLite (booléens en 0 ou 1, tableaux en texte
 * JSON, colonnes en snake_case) transformées en vues des écrans, les mêmes que celles de l'API. Statut d'unité en
 * quatre dimensions (D14) et pastille de synthèse ; filtres de la liste. Fonctions pures, testées.
 */
import {
	isAvailable,
	MEDIA_VARIANT_SIZES,
	mediaVariantPath,
	occupancyOf,
	type MediaStatus,
	type MediaVariantSize,
	type MediaView,
	type PropertyView,
	type TechnicalStatus,
	type UnitType,
	type UnitView
} from '@ziga/shared/properties';
import type { DocumentView } from '@ziga/shared/documents';
import { fr } from '../i18n/fr';

type Row = Record<string, unknown>;

const str = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
const int = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
const bool = (v: unknown) => v === 1 || v === true || v === '1';

/** Tableau PostgreSQL synchronisé : texte JSON ; une valeur illisible vaut une liste vide. */
function list<T>(v: unknown): T[] {
	if (Array.isArray(v)) return v as T[];
	if (typeof v !== 'string' || !v) return [];
	try {
		const parsed = JSON.parse(v) as unknown;
		return Array.isArray(parsed) ? (parsed as T[]) : [];
	} catch {
		return [];
	}
}

export function toProperty(r: Row): PropertyView {
	const lat = int(r.gps_lat);
	const lng = int(r.gps_lng);
	return {
		id: String(r.id),
		ownerId: String(r.owner_id ?? ''),
		type: String(r.type) as PropertyView['type'],
		operation: (str(r.operation) ?? 'rent') as PropertyView['operation'],
		name: String(r.name ?? ''),
		communeId: str(r.commune_id),
		neighborhoodId: str(r.neighborhood_id),
		addressHint: str(r.address_hint),
		gps: lat !== null && lng !== null ? { lat, lng, accuracyM: int(r.gps_accuracy_m) } : null,
		declaredLandDocuments: list(r.declared_land_documents),
		notes: str(r.notes),
		// Une fiche créée sur l'appareil n'a pas encore de statut renvoyé : elle naît en brouillon.
		recordStatus: (str(r.record_status) ?? 'draft') as PropertyView['recordStatus'],
		archivedAt: str(r.archived_at),
		createdAt: str(r.created_at) ?? '',
		updatedAt: str(r.updated_at) ?? ''
	};
}

export function toUnit(r: Row): UnitView {
	// Au lot 07, aucun bail : l'occupation calculée est « libre » (lot 08 : signaux des baux de l'unité).
	const occupancy = occupancyOf([]);
	const recordStatus = (str(r.record_status) ?? 'draft') as UnitView['recordStatus'];
	const technicalStatus = (str(r.technical_status) ?? 'ready') as TechnicalStatus;
	return {
		id: String(r.id),
		propertyId: String(r.property_id ?? ''),
		type: String(r.type) as UnitType,
		label: String(r.label ?? ''),
		rooms: {
			bedrooms: int(r.bedrooms) ?? 0,
			livingRooms: int(r.living_rooms) ?? 0,
			kitchens: int(r.kitchens) ?? 0,
			bathrooms: int(r.bathrooms) ?? 0,
			terraces: int(r.terraces) ?? 0,
			laundries: int(r.laundries) ?? 0
		},
		surfaceM2: int(r.surface_m2),
		landAreaM2: int(r.land_area_m2),
		usage: (str(r.usage) ?? 'residential') as UnitView['usage'],
		furnished: bool(r.furnished),
		amenities: list(r.amenities),
		rent: int(r.rent),
		charges: int(r.charges),
		depositAmount: int(r.deposit_amount),
		advanceMonths: int(r.advance_months),
		assignedAgentId: str(r.assigned_agent_id),
		recordStatus,
		archivedAt: str(r.archived_at),
		technicalStatus,
		technicalReason: str(r.technical_reason),
		technicalExpectedOn: str(r.technical_expected_on),
		occupancy,
		available: isAvailable({ recordStatus, occupancy, technicalStatus }),
		createdAt: str(r.created_at) ?? '',
		updatedAt: str(r.updated_at) ?? ''
	};
}

export function toMedia(r: Row): MediaView {
	const key = str(r.variants_key);
	const status = (str(r.status) ?? 'pending') as MediaStatus;
	return {
		id: String(r.id),
		propertyId: String(r.property_id ?? ''),
		unitId: str(r.unit_id),
		mimeType: String(r.mime_type ?? 'image/jpeg') as MediaView['mimeType'],
		byteSize: int(r.byte_size) ?? 0,
		position: int(r.position) ?? 0,
		caption: str(r.caption),
		status,
		error: str(r.error),
		width: int(r.width),
		height: int(r.height),
		variants:
			status === 'ready' && key
				? (Object.fromEntries(MEDIA_VARIANT_SIZES.map((s) => [s, mediaVariantPath(key, s)])) as Record<MediaVariantSize, string>)
				: null,
		createdAt: str(r.created_at) ?? '',
		processedAt: str(r.processed_at)
	};
}

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'secondary';

/** Pastille de synthèse d'une unité (cartes et tableaux) : la dimension qui compte le plus. */
export function unitSummary(u: Pick<UnitView, 'recordStatus' | 'occupancy' | 'technicalStatus' | 'available'>): {
	label: string;
	tone: Tone;
} {
	const t = fr.properties;
	if (u.recordStatus === 'archived') return { label: t.summary.archived, tone: 'secondary' };
	if (u.recordStatus === 'draft') return { label: t.summary.draft, tone: 'secondary' };
	if (u.available) return { label: t.summary.available, tone: 'success' };
	if (u.occupancy === 'occupied') return { label: t.summary.occupied, tone: 'info' };
	if (u.occupancy === 'reserved') return { label: t.summary.reserved, tone: 'info' };
	return { label: t.technical[u.technicalStatus], tone: u.technicalStatus === 'unavailable' ? 'danger' : 'warning' };
}

/** Les quatre dimensions du statut, une pastille chacune (fiche de l'unité). */
export function unitDimensions(u: UnitView): { key: string; label: string; value: string; tone: Tone }[] {
	const t = fr.properties;
	return [
		{
			key: 'fiche',
			label: t.recordLabel,
			value: t.recordStatus[u.recordStatus],
			tone: u.recordStatus === 'active' ? 'success' : 'secondary'
		},
		{ key: 'occupation', label: t.occupancyLabel, value: t.occupancy[u.occupancy], tone: u.occupancy === 'free' ? 'success' : 'info' },
		{
			key: 'technique',
			label: t.technicalLabel,
			value: t.technical[u.technicalStatus],
			tone: u.technicalStatus === 'ready' ? 'success' : u.technicalStatus === 'unavailable' ? 'danger' : 'warning'
		},
		{ key: 'annonce', label: t.listingLabel, value: t.listingNotPublished, tone: 'secondary' }
	];
}

export interface PropertyFilters {
	neighborhoodId: string;
	availability: 'all' | 'available' | 'unavailable';
	technical: 'all' | TechnicalStatus;
	ownerId: string;
}

export const NO_FILTERS: PropertyFilters = { neighborhoodId: '', availability: 'all', technical: 'all', ownerId: '' };

/**
 * Filtres de la liste : un bien est gardé s'il passe les filtres du bien (quartier, propriétaire) et, pour la
 * disponibilité et l'état technique, si au moins une de ses unités y répond.
 */
export function filterProperties(properties: PropertyView[], units: UnitView[], f: PropertyFilters): PropertyView[] {
	return properties.filter((p) => {
		if (f.neighborhoodId && p.neighborhoodId !== f.neighborhoodId) return false;
		if (f.ownerId && p.ownerId !== f.ownerId) return false;
		if (f.availability === 'all' && f.technical === 'all') return true;
		const mine = units.filter((u) => u.propertyId === p.id);
		return mine.some(
			(u) =>
				(f.availability === 'all' || (f.availability === 'available') === u.available) &&
				(f.technical === 'all' || u.technicalStatus === f.technical)
		);
	});
}

/**
 * Libellés proposés pour ajouter plusieurs unités d'un coup : « Appartement 1 » … « Appartement 6 », en sautant ceux
 * déjà pris dans le bien (casse et accents confondus).
 */
export function suggestLabels(prefix: string, count: number, taken: string[]): string[] {
	const key = (s: string) =>
		s
			.normalize('NFD')
			.replace(/\p{Diacritic}/gu, '')
			.toLowerCase()
			.replace(/\s+/g, ' ')
			.trim();
	const used = new Set(taken.map(key));
	const base = prefix.trim() || fr.properties.unit;
	const out: string[] = [];
	for (let n = 1; out.length < count && n < count + taken.length + 100; n += 1) {
		const label = `${base} ${n}`;
		if (!used.has(key(label))) out.push(label);
	}
	return out;
}

/** Photos d'un objet (bien seul ou unité), dans l'ordre de la galerie, sans les photos retirées. */
export function galleryOf(media: MediaView[], propertyId: string, unitId: string | null): MediaView[] {
	return media
		.filter((m) => m.propertyId === propertyId && m.unitId === unitId && m.status !== 'removed')
		.sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** Nouvel ordre après avoir avancé ou reculé une photo : positions 0, 1, 2… réécrites seulement là où elles changent. */
export function reorder(gallery: MediaView[], id: string, direction: -1 | 1): { id: string; position: number }[] {
	const ids = gallery.map((m) => m.id);
	const i = ids.indexOf(id);
	const j = i + direction;
	if (i < 0 || j < 0 || j >= ids.length) return [];
	[ids[i], ids[j]] = [ids[j]!, ids[i]!];
	return ids.flatMap((mid, position) => (gallery.find((m) => m.id === mid)!.position === position ? [] : [{ id: mid, position }]));
}

/** Métadonnées d'un document privé (direction et gestion seulement : les autres rôles n'en reçoivent aucune). */
export function toDocument(r: Row): DocumentView {
	return {
		id: String(r.id),
		type: String(r.type) as DocumentView['type'],
		ownerId: str(r.owner_id),
		mandateId: str(r.mandate_id),
		propertyId: str(r.property_id),
		unitId: str(r.unit_id),
		version: int(r.version) ?? 1,
		replacesId: str(r.replaces_id),
		fileName: String(r.file_name ?? ''),
		mimeType: String(r.mime_type ?? 'application/pdf') as DocumentView['mimeType'],
		byteSize: int(r.byte_size) ?? 0,
		sha256: str(r.sha256),
		status: (str(r.status) ?? 'pending') as DocumentView['status'],
		restriction: str(r.restriction) as DocumentView['restriction'],
		error: null,
		uploadedBy: String(r.uploaded_by ?? ''),
		createdAt: str(r.created_at) ?? '',
		activatedAt: str(r.activated_at),
		replacedAt: str(r.replaced_at),
		withdrawnAt: str(r.withdrawn_at),
		withdrawalReason: str(r.withdrawal_reason)
	};
}
