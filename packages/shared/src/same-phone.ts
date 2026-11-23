/**
 * Fiches au même numéro dans une organisation (dette du lot 10 ter, faite au lot 11) : la fiche d'un locataire ou
 * d'un propriétaire affiche « Une autre fiche porte ce numéro », avec un lien vers chaque autre fiche active. Lu sur
 * l'appareil (données de l'organisation seulement, règle 15). Une fiche archivée n'entre pas dans le signal.
 * Le même nom au même numéro est un doublon probable (import) ; un autre nom peut être un colocataire ou un parent.
 */
import { placeNameKey } from './geography.js';

export interface PhoneRecord {
	id: string;
	name: string;
	phone: string | null;
	status: string;
}

export interface SamePhoneRecord {
	id: string;
	name: string;
	sameName: boolean;
}

export function otherRecordsWithSamePhone(record: PhoneRecord, all: readonly PhoneRecord[]): SamePhoneRecord[] {
	if (!record.phone || record.status === 'archived') return [];
	const key = placeNameKey(record.name);
	return all
		.filter((r) => r.id !== record.id && r.phone === record.phone && r.status !== 'archived')
		.map((r) => ({ id: r.id, name: r.name, sameName: placeNameKey(r.name) === key }))
		.sort((a, b) => Number(b.sameName) - Number(a.sameName) || a.name.localeCompare(b.name, 'fr'));
}
