/**
 * Biens et unités (lot 07) : listes fermées et règles pures du statut d'unité en quatre dimensions (D14, règle 13 de
 * CLAUDE.md). La migration 0010_properties reprend les mêmes listes dans ses contraintes CHECK ; un test compare les
 * deux. Les libellés français sont dans apps/web/src/lib/i18n/fr.ts.
 */
import { z } from 'zod';
import { isIsoDate } from './dates.js';
import { idSchema } from './ids.js';
import { fcfaSchema } from './money.js';
import { patchShape } from './schema-helpers.js';

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

// ---------------------------------------------------------------- schémas (API, synchronisation, formulaires)

/** Statut d'une fiche : brouillon, puis active ; archivée ; une fiche archivée peut être réactivée. */
export const RECORD_TRANSITIONS: Record<RecordStatus, readonly RecordStatus[]> = {
	draft: ['active', 'archived'],
	active: ['archived'],
	archived: ['active']
};
export function canChangeRecordStatus(from: RecordStatus, to: RecordStatus): boolean {
	return RECORD_TRANSITIONS[from].includes(to);
}

const optionalText = (max: number) =>
	z
		.string()
		.trim()
		.max(max, { error: 'Champ trop long.' })
		.nullish()
		.transform((v) => (v ? v : null));

const optionalInt = (min: number, max: number, label: string) =>
	z
		.number({ error: `${label} : nombre entier attendu.` })
		.int({ error: `${label} : nombre entier attendu.` })
		.min(min, { error: `${label} : ${min} au moins.` })
		.max(max, { error: `${label} : ${max} au plus.` })
		.nullish()
		.transform((v) => v ?? null);

const optionalFcfa = fcfaSchema.nullish().transform((v) => v ?? null);

/** Commune du référentiel : son identifiant (« ouagadougou », « saaba »). */
export const communeIdSchema = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, { error: 'Commune invalide.' });

/** Point GPS pris sur place : jamais publié tel quel (publicLocation). */
export const gpsPointSchema = z.object({
	lat: z.number().min(-90).max(90),
	lng: z.number().min(-180).max(180),
	accuracyM: optionalInt(0, 100_000, 'Précision')
});
export type GpsPoint = z.output<typeof gpsPointSchema>;

const landDocuments = z
	.array(z.enum(DECLARED_LAND_DOCUMENTS))
	.max(DECLARED_LAND_DOCUMENTS.length)
	.default([])
	.refine((list) => new Set(list).size === list.length, { error: 'Un document est déclaré deux fois.' })
	.refine((list) => !list.includes('none') || list.length === 1, { error: '« Aucun » exclut les autres documents.' });

const propertyFields = {
	ownerId: idSchema,
	type: z.enum(PROPERTY_TYPES),
	operation: z.enum(PROPERTY_OPERATIONS).default('rent'),
	name: z.string().trim().min(2, { error: 'Indiquez un nom (2 caractères au moins).' }).max(120, { error: 'Nom trop long.' }),
	communeId: communeIdSchema.nullish().transform((v) => v ?? null),
	neighborhoodId: idSchema.nullish().transform((v) => v ?? null),
	addressHint: optionalText(300),
	gps: gpsPointSchema.nullish().transform((v) => v ?? null),
	declaredLandDocuments: landDocuments,
	notes: optionalText(2000)
};

function checkLocation(p: { communeId?: string | null; neighborhoodId?: string | null }, ctx: z.RefinementCtx): void {
	if (p.neighborhoodId && !p.communeId)
		ctx.addIssue({ code: 'custom', path: ['communeId'], message: 'Choisissez la commune du quartier.' });
}

/** Fiche complète (revalidation côté serveur après une modification partielle). */
export const propertySchema = z.object(propertyFields).superRefine(checkLocation);
export type PropertyData = z.output<typeof propertySchema>;

/** Création : identifiant UUIDv7 du client ; la fiche naît en brouillon. */
export const createPropertySchema = z.object({ id: idSchema, ...propertyFields }).superRefine(checkLocation);
export type CreatePropertyInput = z.input<typeof createPropertySchema>;
export type CreatePropertyData = z.output<typeof createPropertySchema>;

/** Modification : champs envoyés seulement, sans valeur par défaut ; le serveur revalide la fiche complète. */
export const updatePropertySchema = z.object(patchShape(propertyFields));
export type UpdatePropertyInput = z.input<typeof updatePropertySchema>;

export const recordStatusSchema = z.object({ status: z.enum(['active', 'archived']) });

const roomCount = (label: string) =>
	z
		.number({ error: `${label} : nombre entier attendu.` })
		.int({ error: `${label} : nombre entier attendu.` })
		.min(0, { error: `${label} : 0 au moins.` })
		.max(50, { error: `${label} : 50 au plus.` })
		.default(0);

export const unitRoomsSchema = z.object({
	bedrooms: roomCount('Chambres'),
	livingRooms: roomCount('Salons'),
	kitchens: roomCount('Cuisines'),
	bathrooms: roomCount('Salles de bain'),
	terraces: roomCount('Terrasses'),
	laundries: roomCount('Buanderies')
});
export type UnitRooms = z.output<typeof unitRoomsSchema>;

/** Pièces modifiées une à une : une pièce absente ne change pas. */
export const unitRoomsPatchSchema = z.object(patchShape(unitRoomsSchema.shape));

const unitFields = {
	type: z.enum(UNIT_TYPES),
	label: z.string().trim().min(1, { error: 'Indiquez un libellé (« Appartement A2 »).' }).max(80, { error: 'Libellé trop long.' }),
	rooms: unitRoomsSchema.default({ bedrooms: 0, livingRooms: 0, kitchens: 0, bathrooms: 0, terraces: 0, laundries: 0 }),
	surfaceM2: optionalInt(1, 100_000, 'Surface'),
	landAreaM2: optionalInt(1, 10_000_000, 'Terrain'),
	usage: z.enum(UNIT_USAGES).default('residential'),
	furnished: z.boolean().default(false),
	amenities: z
		.array(z.enum(AMENITIES))
		.max(AMENITIES.length)
		.default([])
		.refine((list) => new Set(list).size === list.length, { error: 'Un équipement est coché deux fois.' }),
	rent: optionalFcfa,
	charges: optionalFcfa,
	depositAmount: optionalFcfa,
	advanceMonths: optionalInt(0, 24, 'Avance')
};

/** Unité complète (revalidation). L'occupation n'en fait jamais partie : elle se calcule. */
export const unitSchema = z.object(unitFields);
export type UnitData = z.output<typeof unitSchema>;

export const createUnitSchema = z.object({ id: idSchema, propertyId: idSchema, ...unitFields });
export type CreateUnitInput = z.input<typeof createUnitSchema>;
export type CreateUnitData = z.output<typeof createUnitSchema>;

/** Modification : champs envoyés seulement, sans valeur par défaut ; les pièces aussi, une à une. */
export const updateUnitSchema = z.object({ ...patchShape(unitFields), rooms: unitRoomsPatchSchema.optional() });
export type UpdateUnitInput = z.input<typeof updateUnitSchema>;

/** État technique : motif obligatoire hors « prête » ; date prévue facultative, seulement hors « prête ». */
export const technicalStatusSchema = z
	.object({
		technicalStatus: z.enum(TECHNICAL_STATUSES),
		reason: optionalText(500),
		expectedOn: z
			.string()
			.refine(isIsoDate, { error: 'Date invalide.' })
			.nullish()
			.transform((v) => v ?? null)
	})
	.superRefine((s, ctx) => {
		if (s.technicalStatus === 'ready') {
			if (s.reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Une unité prête n’a pas de motif.' });
			if (s.expectedOn) ctx.addIssue({ code: 'custom', path: ['expectedOn'], message: 'Une unité prête n’a pas de date prévue.' });
		} else if (!s.reason || s.reason.length < 3) {
			ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Indiquez le motif (3 caractères au moins).' });
		}
	});
export type TechnicalStatusInput = z.input<typeof technicalStatusSchema>;
export type TechnicalStatusData = z.output<typeof technicalStatusSchema>;

/** Affectation à un agent de terrain (ou retrait : null). */
export const assignUnitSchema = z.object({ agentId: idSchema.nullable() });

// ---------------------------------------------------------------- vues (API et écrans)

export interface PropertyView {
	id: string;
	ownerId: string;
	type: PropertyType;
	operation: PropertyOperation;
	name: string;
	communeId: string | null;
	neighborhoodId: string | null;
	addressHint: string | null;
	gps: GpsPoint | null;
	declaredLandDocuments: DeclaredLandDocument[];
	notes: string | null;
	recordStatus: RecordStatus;
	archivedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface UnitView {
	id: string;
	propertyId: string;
	type: UnitType;
	label: string;
	rooms: UnitRooms;
	surfaceM2: number | null;
	landAreaM2: number | null;
	usage: UnitUsage;
	furnished: boolean;
	amenities: Amenity[];
	rent: number | null;
	charges: number | null;
	depositAmount: number | null;
	advanceMonths: number | null;
	assignedAgentId: string | null;
	recordStatus: RecordStatus;
	archivedAt: string | null;
	technicalStatus: TechnicalStatus;
	technicalReason: string | null;
	technicalExpectedOn: string | null;
	/** Calculée (jamais stockée) : libre tant qu'il n'y a pas de bail (lot 08). */
	occupancy: Occupancy;
	available: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface PropertyDetailView extends PropertyView {
	units: UnitView[];
}
