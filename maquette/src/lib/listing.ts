import type { Dataset, Unit } from './types';

/** Une annonce n'est visible que si l'unité est publiée ET libre : la disponibilité est toujours exacte. */
export function isListed(unit: Unit): boolean {
	return unit.visibility === 'published' && unit.status === 'free';
}

export function listingTitle(unit: Unit, district: string): string {
	if (unit.kind === 'Chambre-salon' || unit.kind === 'Studio' || unit.kind === 'Boutique') return `${unit.kind} — ${district}`;
	return `${unit.kind} ${unit.rooms} pièces — ${district}`;
}

export function listings(data: Dataset) {
	return data.units
		.filter(isListed)
		.map((unit) => {
			const property = data.properties.find((p) => p.id === unit.propertyId)!;
			return { unit, property, title: listingTitle(unit, property.district) };
		});
}
