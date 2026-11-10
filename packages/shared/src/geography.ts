/**
 * Référentiel géographique (lot 07) : communes et quartiers de la plateforme (migration 0009_geography).
 *
 * Le point GPS d'un bien, pris sur place, n'est jamais publié : la vitrine (lot 12) ne montre que le centre du quartier,
 * ou le centre de la commune quand le quartier n'a pas de point. Aucun point n'est vérifié sur place au départ
 * (`verified = false`) : ce sont des positions approximatives tirées d'OpenStreetMap (© les contributeurs
 * d'OpenStreetMap, ODbL).
 */
import { z } from 'zod';
import { idSchema } from './ids.js';

export interface GeoPoint {
	lat: number;
	lng: number;
}

/** Coordonnées facultatives : les deux ensemble, ou aucune (contrainte de la table `neighborhoods`). */
export interface OptionalPoint {
	lat: number | null;
	lng: number | null;
}

/**
 * Nom comparé sans accents, sans casse, espaces réduits : « Somgandé » et « somgande » sont le même quartier.
 * Même règle que la fonction SQL `geo_name_key`, qui porte l'index d'unicité des quartiers.
 */
export function placeNameKey(name: string): string {
	return name
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '')
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim();
}

export type PublicLocationPrecision = 'neighborhood' | 'commune';

export interface PublicLocation extends GeoPoint {
	precision: PublicLocationPrecision;
}

/** Ce que la vitrine sait d'un bien pour le placer : son quartier et sa commune. Le point du bien n'en fait pas partie. */
export interface PlaceOfProperty {
	neighborhood: OptionalPoint;
	commune: GeoPoint;
}

function hasPoint(p: OptionalPoint): p is GeoPoint {
	return typeof p.lat === 'number' && Number.isFinite(p.lat) && typeof p.lng === 'number' && Number.isFinite(p.lng);
}

/**
 * Position publiée d'un bien : centre du quartier, ou centre de la commune quand le quartier n'a pas de point.
 * Ne reçoit jamais le point GPS du bien : seuls les champs du quartier et de la commune sont lus.
 */
export function publicLocation(place: PlaceOfProperty): PublicLocation {
	if (hasPoint(place.neighborhood)) {
		return { lat: place.neighborhood.lat, lng: place.neighborhood.lng, precision: 'neighborhood' };
	}
	return { lat: place.commune.lat, lng: place.commune.lng, precision: 'commune' };
}

// ---------------------------------------------------------------- back-office : quartiers (lot 07)

const neighborhoodName = z
	.string()
	.trim()
	.min(2, { error: 'Indiquez le nom du quartier (2 caractères au moins).' })
	.max(80, { error: 'Nom trop long (80 caractères au plus).' })
	.transform((v) => v.replace(/\s+/g, ' '));

/** Point central : les deux coordonnées ensemble ; null pour l'effacer. */
export const neighborhoodPointSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

export const createNeighborhoodSchema = z.object({
	id: idSchema,
	communeId: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, { error: 'Commune invalide.' }),
	name: neighborhoodName,
	point: neighborhoodPointSchema.nullish().transform((v) => v ?? null)
});
export type CreateNeighborhoodInput = z.input<typeof createNeighborhoodSchema>;

/** Correction : nom, point (null l'efface), vérification sur place (exige un point). */
export const updateNeighborhoodSchema = z
	.object({
		name: neighborhoodName.optional(),
		point: neighborhoodPointSchema.nullable().optional(),
		verified: z.boolean().optional()
	})
	.refine((u) => Object.keys(u).length > 0, { error: 'Rien à modifier.' });
export type UpdateNeighborhoodInput = z.input<typeof updateNeighborhoodSchema>;

export interface CommuneView extends GeoPoint {
	id: string;
	name: string;
	osmRef: string | null;
	verified: boolean;
}

export interface NeighborhoodView extends OptionalPoint {
	id: string;
	communeId: string;
	name: string;
	osmRef: string | null;
	verified: boolean;
	createdAt: string;
	updatedAt: string;
}
