/**
 * Biens à vendre de la démo (profil acheteur). Fiches simples, sans pipeline de vente (décision D08).
 * Les documents affichés sont déclarés par le vendeur : la plateforme ne garantit pas la propriété.
 */
export interface SaleListing {
	id: string;
	title: string;
	kind: 'Villa' | 'Parcelle' | 'Immeuble';
	city: 'Ouagadougou' | 'Saaba';
	district: string;
	price: number;
	surface: number;
	rooms?: number;
	document: string;
	photos: number;
}

export const saleListings: SaleListing[] = [
	{ id: 's1', title: 'Villa 4 pièces avec cour', kind: 'Villa', city: 'Ouagadougou', district: 'Ouaga 2000', price: 85_000_000, surface: 400, rooms: 4, document: 'PUH', photos: 6 },
	{ id: 's2', title: 'Parcelle viabilisée de 300 m²', kind: 'Parcelle', city: 'Saaba', district: 'Saaba centre', price: 9_500_000, surface: 300, document: 'Attestation d’attribution', photos: 3 },
	{ id: 's3', title: 'Immeuble R+1, 4 appartements', kind: 'Immeuble', city: 'Ouagadougou', district: 'Patte d’Oie', price: 120_000_000, surface: 450, rooms: 12, document: 'Titre foncier', photos: 8 }
];
