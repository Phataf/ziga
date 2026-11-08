import { describe, expect, it } from 'vitest';
import { newId } from './ids.js';
import { createOrganizationSchema, representativeSchema, updateOrganizationSchema } from './organizations.js';

describe('schémas des organisations', () => {
	it('création : identifiant UUIDv7 du client, type, nom, téléphone en E.164, commune', () => {
		const id = newId();
		expect(
			createOrganizationSchema.parse({ id, type: 'agency', legalName: ' Immo Faso ', phone: '70 12 34 56', commune: 'Ouagadougou' })
		).toEqual({
			id,
			type: 'agency',
			legalName: 'Immo Faso',
			phone: '+22670123456',
			commune: 'Ouagadougou'
		});
		expect(createOrganizationSchema.safeParse({ id: 'abc', type: 'agency', legalName: 'X', phone: '1', commune: '' }).success).toBe(false);
	});

	it('représentant légal : « Autre » exige de préciser la pièce', () => {
		expect(representativeSchema.safeParse({ idType: 'other' }).success).toBe(false);
		expect(representativeSchema.parse({ idType: 'other', idTypeOther: 'Permis de conduire' }).idTypeOther).toBe('Permis de conduire');
		// Une précision n'est gardée que pour « Autre ».
		expect(representativeSchema.parse({ idType: 'cnib', idTypeOther: 'ignoré' }).idTypeOther).toBeNull();
	});

	it('représentant légal : champs vides ramenés à « non renseigné », date au format ISO', () => {
		const r = representativeSchema.parse({ name: '', idIssuedOn: '2024-03-15' });
		expect(r.name).toBeNull();
		expect(r.idIssuedOn).toBe('2024-03-15');
		expect(representativeSchema.safeParse({ idIssuedOn: '15/03/2024' }).success).toBe(false);
	});

	it('paramètres : RCCM et IFU normalisés en majuscules, modification partielle', () => {
		expect(updateOrganizationSchema.parse({ rccm: ' bf  oua 2019 b 1234 ', ifu: '' })).toEqual({ rccm: 'BF OUA 2019 B 1234', ifu: null });
		expect(updateOrganizationSchema.parse({})).toEqual({});
	});
});
