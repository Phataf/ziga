import { describe, expect, it } from 'vitest';
import {
	importText,
	parseImportAmount,
	parseImportBoolean,
	parseImportChoice,
	parseImportDate,
	parseImportInteger,
	parseImportPercent,
	parseImportPhone
} from './import-values.js';

const ok = <T>(value: T) => ({ value });

describe('montants (règle 2, prompt §6)', () => {
	it.each([
		['75000', 75000],
		['75.000', 75000],
		['75 000', 75000],
		['75 000', 75000],
		['75 000', 75000],
		['75 000 F', 75000],
		['75000F', 75000],
		['75000 FCFA', 75000],
		['75 000 F CFA', 75000],
		['75.000 fcfa', 75000],
		['XOF 75000', 75000],
		['1.500.000', 1_500_000],
		['1 500 000 F', 1_500_000],
		['75,000', 75000],
		['75 000,00', 75000],
		['75000,0', 75000],
		['0', 0],
		[' 25 000 ', 25000]
	])('« %s » → %i', (input, expected) => {
		expect(parseImportAmount(input)).toEqual(ok(expected));
	});

	it('une cellule nombre entière est lue telle quelle', () => {
		expect(parseImportAmount(75000)).toEqual(ok(75000));
		expect(parseImportAmount(0)).toEqual(ok(0));
	});

	it('vide : aucune valeur, sans erreur', () => {
		expect(parseImportAmount('')).toEqual(ok(null));
		expect(parseImportAmount('   ')).toEqual(ok(null));
		expect(parseImportAmount(null)).toEqual(ok(null));
	});

	it.each([
		['75 000,50', 'sans centimes'],
		['75000.5', 'sans centimes'],
		['-5000', 'négatif'],
		['- 5 000 F', 'négatif'],
		['soixante-quinze mille', 'chiffres'],
		['75 000 €', 'chiffres'],
		['12/03/2024', 'chiffres']
	])('« %s » refusé (%s)', (input, word) => {
		const r = parseImportAmount(input);
		expect('error' in r && r.error).toContain(word);
	});

	it('nombre décimal ou négatif dans une cellule nombre : refusé', () => {
		expect('error' in parseImportAmount(75000.5)).toBe(true);
		expect('error' in parseImportAmount(-1)).toBe(true);
	});

	it('le message dit quoi écrire', () => {
		const r = parseImportAmount('beaucoup');
		expect('error' in r && r.error).toBe('montant en chiffres attendu, par exemple 75 000.');
	});
});

describe('téléphones (E.164, prompt §6)', () => {
	it.each([
		['70123456', '+22670123456'],
		['70 12 34 56', '+22670123456'],
		['70-12-34-56', '+22670123456'],
		['70.12.34.56', '+22670123456'],
		['+226 70 12 34 56', '+22670123456'],
		['+22670123456', '+22670123456'],
		['00226 70 12 34 56', '+22670123456'],
		['226 70 12 34 56', '+22670123456'],
		['(+226) 70 12 34 56', '+22670123456'],
		['Tél : 70 12 34 56', '+22670123456'],
		['tel. 76 54 32 10', '+22676543210'],
		['05 12 34 56', '+22605123456'],
		['+33 6 12 34 56 78', '+33612345678']
	])('« %s » → %s', (input, expected) => {
		expect(parseImportPhone(input)).toEqual(ok(expected));
	});

	it('une cellule nombre (Excel retire la mise en forme)', () => {
		expect(parseImportPhone(70123456)).toEqual(ok('+22670123456'));
		expect(parseImportPhone(22670123456)).toEqual(ok('+22670123456'));
	});

	it('vide : aucune valeur', () => {
		expect(parseImportPhone('')).toEqual(ok(null));
		expect(parseImportPhone(null)).toEqual(ok(null));
	});

	it('deux numéros dans la même cellule : le message dit où mettre le second', () => {
		for (const input of ['70123456 / 76543210', '70 12 34 56 ou 76 54 32 10', '70123456;76543210']) {
			const r = parseImportPhone(input);
			expect('error' in r && r.error).toBe('un seul numéro par cellule ; mettez le second dans « Téléphone 2 ».');
		}
	});

	it.each(['7012345', '701234567', '80 12 34 56', 'inconnu', '+226 90 12 34'])('« %s » refusé avec un exemple', (input) => {
		const r = parseImportPhone(input);
		expect('error' in r && r.error).toBe('8 chiffres attendus, par exemple 70 12 34 56.');
	});
});

describe('dates (jj/mm/aaaa, aaaa-mm-jj, numéro de série Excel)', () => {
	it.each([
		['01/03/2021', '2021-03-01'],
		['1/3/2021', '2021-03-01'],
		['01-03-2021', '2021-03-01'],
		['01.03.2021', '2021-03-01'],
		['2021-03-01', '2021-03-01'],
		['2021-03-01T00:00:00.000Z', '2021-03-01'],
		['44256', '2021-03-01'],
		[' 15/11/2026 ', '2026-11-15']
	])('« %s » → %s', (input, expected) => {
		expect(parseImportDate(input)).toEqual(ok(expected));
	});

	it('numéro de série Excel (calendrier 1900)', () => {
		expect(parseImportDate(44256)).toEqual(ok('2021-03-01'));
		expect(parseImportDate(45658)).toEqual(ok('2025-01-01'));
		expect(parseImportDate(36526)).toEqual(ok('2000-01-01'));
		// Partie horaire ignorée.
		expect(parseImportDate(44256.75)).toEqual(ok('2021-03-01'));
	});

	it('cellule date lue par le lecteur (minuit UTC)', () => {
		expect(parseImportDate(new Date(Date.UTC(2021, 2, 1)))).toEqual(ok('2021-03-01'));
	});

	it('vide : aucune valeur', () => {
		expect(parseImportDate('')).toEqual(ok(null));
		expect(parseImportDate(null)).toEqual(ok(null));
	});

	it.each(['31/02/2021', '2021-02-30', '13/13/2021', 'mars 2021', '01/03/21', '12', '1/3'])(
		'« %s » refusé avec le format attendu',
		(input) => {
			const r = parseImportDate(input);
			expect('error' in r && r.error).toBe('date attendue au format jj/mm/aaaa, par exemple 01/03/2021.');
		}
	);

	it('numéro de série hors des années plausibles : refusé', () => {
		expect('error' in parseImportDate(5)).toBe(true);
		expect('error' in parseImportDate(3_000_000)).toBe(true);
	});
});

describe('nombres entiers, pourcentages, oui ou non, listes', () => {
	it('entier dans ses bornes', () => {
		expect(parseImportInteger('3', 0, 50)).toEqual(ok(3));
		expect(parseImportInteger(3, 0, 50)).toEqual(ok(3));
		expect(parseImportInteger('', 0, 50)).toEqual(ok(null));
		const r = parseImportInteger('51', 0, 50);
		expect('error' in r && r.error).toBe('nombre entier de 0 à 50 attendu.');
		expect('error' in parseImportInteger('2,5', 0, 50)).toBe(true);
	});

	it('pourcentage en points de base', () => {
		expect(parseImportPercent('10')).toEqual(ok(1000));
		expect(parseImportPercent('10 %')).toEqual(ok(1000));
		expect(parseImportPercent('8,5 %')).toEqual(ok(850));
		expect(parseImportPercent('8.5%')).toEqual(ok(850));
		// Cellule mise en forme « pourcentage » : Excel stocke 0,1 pour 10 %.
		expect(parseImportPercent(0.1)).toEqual(ok(1000));
		expect(parseImportPercent(10)).toEqual(ok(1000));
		expect(parseImportPercent('')).toEqual(ok(null));
		const r = parseImportPercent('120 %');
		expect('error' in r && r.error).toBe('pourcentage de 0 à 100 attendu, par exemple 10 %.');
		expect('error' in parseImportPercent('8,555')).toBe(true);
	});

	it('oui ou non', () => {
		for (const yes of ['Oui', 'oui', 'O', 'X', 'x', 'vrai', '1', true, 1]) expect(parseImportBoolean(yes)).toEqual(ok(true));
		for (const no of ['Non', 'non', 'N', 'faux', '0', false, 0]) expect(parseImportBoolean(no)).toEqual(ok(false));
		expect(parseImportBoolean('')).toEqual(ok(null));
		const r = parseImportBoolean('peut-être');
		expect('error' in r && r.error).toBe('« Oui » ou « Non » attendu.');
	});

	it('valeur d’une liste, sans accents ni casse, avec ses variantes', () => {
		const choices = [
			{ value: 'person', label: 'Personne' },
			{ value: 'company', label: 'Société', aliases: ['Entreprise', 'SARL'] },
			{ value: 'group', label: 'Groupe d’indivisaires', aliases: ['Indivision'] }
		] as const;
		expect(parseImportChoice('societe', choices)).toEqual(ok('company'));
		expect(parseImportChoice('  SOCIÉTÉ ', choices)).toEqual(ok('company'));
		expect(parseImportChoice('sarl', choices)).toEqual(ok('company'));
		expect(parseImportChoice("Groupe d'indivisaires", choices)).toEqual(ok('group'));
		expect(parseImportChoice('indivision', choices)).toEqual(ok('group'));
		expect(parseImportChoice('', choices)).toEqual(ok(null));
		const r = parseImportChoice('Association', choices);
		expect('error' in r && r.error).toBe('valeur de la liste attendue : Personne, Société, Groupe d’indivisaires.');
	});

	it('texte : nombres sans « .0 », espaces réduits', () => {
		expect(importText('  Kaboré   Issouf ')).toBe('Kaboré Issouf');
		expect(importText(12)).toBe('12');
		expect(importText('')).toBeNull();
		expect(importText(null)).toBeNull();
		expect(importText(new Date(Date.UTC(2021, 2, 1)))).toBe('01/03/2021');
	});
});
