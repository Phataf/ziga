/**
 * Biens et unités (lot 07) : listes fermées et règles pures du statut d'unité en quatre dimensions (D14, règle 13 de
 * CLAUDE.md). La migration 0010_properties reprend les mêmes listes dans ses contraintes CHECK ; un test compare les
 * deux. Les libellés français sont dans apps/web/src/lib/i18n/fr.ts.
 */

export const PROPERTY_TYPES = ['house', 'apartment_building', 'shared_compound', 'commercial', 'land'] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

/** Opération visée : location, vente, ou les deux. */
export const PROPERTY_OPERATIONS = ['rent', 'sale', 'both'] as const;
export type PropertyOperation = (typeof PROPERTY_OPERATIONS)[number];

/** Statut de la fiche (bien ou unité), saisi. */
export const RECORD_STATUSES = ['draft', 'active', 'archived'] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

/**
 * Documents fonciers déclarés sur le bien (déclaration, pas une pièce : la pièce va au registre des documents).
 * `none` (« aucun ») exclut les autres ; une liste vide veut dire « non renseigné ».
 */
export const DECLARED_LAND_DOCUMENTS = ['apfr', 'allocation_certificate', 'puh', 'title_deed', 'none'] as const;
export type DeclaredLandDocument = (typeof DECLARED_LAND_DOCUMENTS)[number];

/** Types d'unité : liste fermée validée par le porteur (plan du lot 07). */
export const UNIT_TYPES = [
	'room_lounge', // chambre-salon
	'single_room', // entrée-couchée
	'celibatorium', // célibatorium
	'studio',
	'apartment',
	'mini_villa',
	'villa',
	'duplex',
	'shop', // boutique
	'office', // bureau
	'store', // magasin
	'warehouse', // entrepôt
	'other'
] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

/** Usage : habitation, professionnel, ou professionnel et habitation. */
export const UNIT_USAGES = ['residential', 'professional', 'mixed'] as const;
export type UnitUsage = (typeof UNIT_USAGES)[number];

/**
 * Équipements : liste fermée validée par le porteur. La clôture et le garage sont des équipements : ils ne sont pas
 * saisis une seconde fois ailleurs (une seule source).
 */
export const AMENITIES = [
	'fence', // clôture
	'guard', // gardien
	'separate_water_meter', // compteur d'eau séparé
	'separate_electricity_meter', // compteur électrique séparé
	'air_conditioning', // climatisation
	'fans', // ventilateurs
	'garage',
	'running_water', // eau courante
	'borehole', // forage
	'water_tower', // château d'eau
	'equipped_kitchen', // cuisine équipée
	'generator', // groupe électrogène
	'indoor_shower', // douche interne
	'indoor_toilet', // WC interne
	'paved_road_access', // accès route bitumée
	'yard_or_parking' // cour ou parking
] as const;
export type Amenity = (typeof AMENITIES)[number];

/** Pièces détaillées d'une unité (nombres entiers, 0 à 50). */
export const UNIT_ROOMS = ['bedrooms', 'living_rooms', 'kitchens', 'bathrooms', 'terraces', 'laundries'] as const;
export type UnitRoom = (typeof UNIT_ROOMS)[number];

/** État technique, saisi : motif obligatoire hors `ready`, date prévue facultative. */
export const TECHNICAL_STATUSES = ['ready', 'to_refurbish', 'under_works', 'unavailable'] as const;
export type TechnicalStatus = (typeof TECHNICAL_STATUSES)[number];

/** Occupation : calculée à partir des baux, jamais stockée ni saisie. */
export const OCCUPANCIES = ['free', 'reserved', 'occupied', 'notice'] as const;
export type Occupancy = (typeof OCCUPANCIES)[number];

/** Photos : 15 par unité (et par bien), 10 Mo au plus avant compression, formats acceptés. */
export const MAX_PHOTOS_PER_OBJECT = 15;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] as const;
export type PhotoMimeType = (typeof PHOTO_MIME_TYPES)[number];

/**
 * Ce qu'un bail dit de l'occupation de son unité. Le lot 08 traduit chaque bail en signal (bail signé à venir :
 * `reserved` ; en vigueur : `occupied` ; préavis donné : `notice` ; terminé ou annulé : aucun signal).
 */
export type OccupancySignal = Exclude<Occupancy, 'free'>;

const OCCUPANCY_PRIORITY: Record<OccupancySignal, number> = { occupied: 3, notice: 2, reserved: 1 };

/**
 * Occupation d'une unité, calculée. Sans bail, elle est `free` (toujours le cas au lot 07). Plusieurs baux : le plus
 * fort l'emporte (occupée, puis en préavis, puis réservée).
 */
export function occupancyOf(signals: readonly OccupancySignal[] = []): Occupancy {
	let best: OccupancySignal | null = null;
	for (const s of signals) if (!best || OCCUPANCY_PRIORITY[s] > OCCUPANCY_PRIORITY[best]) best = s;
	return best ?? 'free';
}

export interface AvailabilityInput {
	recordStatus: RecordStatus;
	occupancy: Occupancy;
	technicalStatus: TechnicalStatus;
}

/** Règle 13 : disponible si la fiche est active, l'unité libre ou en préavis, et prête. */
export function isAvailable(unit: AvailabilityInput): boolean {
	return unit.recordStatus === 'active' && (unit.occupancy === 'free' || unit.occupancy === 'notice') && unit.technicalStatus === 'ready';
}
