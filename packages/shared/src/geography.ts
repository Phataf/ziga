/**
 * Référentiel géographique (lot 07) : communes et quartiers de la plateforme (migration 0009_geography).
 *
 * Le point GPS d'un bien, pris sur place, n'est jamais publié : la vitrine (lot 12) ne montre que le centre du quartier,
 * ou le centre de la commune quand le quartier n'a pas de point. Aucun point n'est vérifié sur place au départ
 * (`verified = false`) : ce sont des positions approximatives tirées d'OpenStreetMap (© les contributeurs
 * d'OpenStreetMap, ODbL).
 */

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
