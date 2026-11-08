/**
 * Modèle d'état des lieux pièce par pièce (articles 8 et 9, lecture à confirmer) :
 * chaque élément a un état d'entrée précis, jamais une formule vague comme « bon état ».
 */
import type { InspectionItem } from './deposit';
import { formatDate } from './format';
import type { Lease, Unit } from './types';

interface RoomTemplate {
	room: string;
	elements: { element: string; entry: string }[];
}

function rooms(unit: Unit): RoomTemplate[] {
	const bedrooms = Math.max(1, unit.rooms - 1);
	const list: RoomTemplate[] = [
		{
			room: 'Séjour',
			elements: [
				{ element: 'Porte d’entrée', entry: 'Porte métallique, serrure 3 points, 2 clés remises' },
				{ element: 'Murs et peinture', entry: 'Peinture blanche refaite, sans trace ni fissure' },
				{ element: 'Sol', entry: 'Carrelage beige, 2 carreaux fêlés près de la fenêtre' },
				{ element: 'Prises et éclairage', entry: '4 prises et 2 points lumineux en état de marche' }
			]
		}
	];
	for (let i = 1; i <= Math.min(bedrooms, 2); i++) {
		list.push({
			room: bedrooms > 1 ? `Chambre ${i}` : 'Chambre',
			elements: [
				{ element: 'Porte', entry: 'Porte isoplane en bois, sans fissure, serrure 1 clé' },
				{ element: 'Fenêtre et moustiquaire', entry: 'Naco à 6 lames, moustiquaire neuve' },
				{ element: 'Murs et peinture', entry: 'Peinture bleu clair, sans trace' }
			]
		});
	}
	if (unit.kind !== 'Boutique' && unit.kind !== 'Chambre-salon' && unit.kind !== 'Entrée-coucher') {
		list.push({
			room: 'Cuisine',
			elements: [
				{ element: 'Évier et robinet', entry: 'Évier inox, robinet sans fuite' },
				{ element: 'Plan de travail', entry: 'Carrelé, sans carreau manquant' }
			]
		});
	}
	list.push({
		room: 'Douche',
		elements: [
			{ element: 'Pommeau et flexible', entry: 'Neufs à l’entrée' },
			{ element: 'WC', entry: 'Chasse d’eau en état de marche, abattant neuf' },
			{ element: 'Carrelage', entry: 'Faïence blanche complète' }
		]
	});
	list.push({
		room: 'Extérieur',
		elements: [
			{ element: 'Portail', entry: 'Portail peint en vert, cadenas fourni' },
			{ element: 'Cour', entry: 'Cour cimentée, propre' }
		]
	});
	return list;
}

/**
 * État des lieux de sortie pré-rempli par l'agent : tout est comparé à l'entrée.
 * La démo reprend l'exemple du porteur : pommeau de douche (10 000 FCFA, devis) et porte de chambre (5 000 FCFA, photo).
 */
export function exitInspection(lease: Lease, unit: Unit, today: string): InspectionItem[] {
	const items: InspectionItem[] = [];
	for (const r of rooms(unit)) {
		for (const e of r.elements) {
			items.push({
				id: `${r.room}-${e.element}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
				room: r.room,
				element: e.element,
				entry: `${e.entry} (état des lieux d’entrée du ${formatDate(lease.startDate)})`,
				finding: 'as_entry'
			});
		}
	}
	const douche = items.find((i) => i.room === 'Douche' && i.element === 'Pommeau et flexible');
	if (douche) Object.assign(douche, { finding: 'tenant', note: 'pommeau et flexible cassés', amount: 10000, proof: 'Devis du plombier' });
	const porte = items.find((i) => i.room.startsWith('Chambre') && i.element === 'Porte');
	if (porte) Object.assign(porte, { finding: 'tenant', note: 'porte fendue', amount: 5000, proof: `Photo datée du ${formatDate(today)}` });
	const murs = items.find((i) => i.room === 'Séjour' && i.element === 'Murs et peinture');
	if (murs) Object.assign(murs, { finding: 'normal_wear', note: 'peinture un peu jaunie' });
	return items;
}

export function roomsOf(items: InspectionItem[]): string[] {
	return [...new Set(items.map((i) => i.room))];
}
