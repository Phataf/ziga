import { describe, expect, it } from 'vitest';
import { NBSP } from './money.js';
import { COUNTRIES, countryOf, formatPhone, isPhone, phoneSchema, toE164, waNumber } from './phone.js';

const join = (...parts: string[]) => parts.join(NBSP);

describe('toE164 : Burkina Faso, pays par défaut', () => {
	it.each([
		['70123456', '+22670123456'],
		['70 12 34 56', '+22670123456'],
		['70-12-34-56', '+22670123456'],
		['0022670123456', '+22670123456'],
		['00 226 70 12 34 56', '+22670123456'],
		['+226 70 12 34 56', '+22670123456'],
		['+22670123456', '+22670123456'],
		['22670123456', '+22670123456'],
		['25 36 48 10', '+22625364810'],
		['05 12 34 56', '+22605123456'],
		[join('+226', '76', '01', '22', '49'), '+22676012249']
	])('%s → %s', (input, expected) => {
		expect(toE164(input)).toBe(expected);
	});

	it.each([
		['7012345', 'trop court'],
		['701234567', 'trop long'],
		['80123456', 'série non attribuée'],
		['+22680123456', 'série non attribuée, en international'],
		['70 12 34 5a', 'lettre'],
		['', 'vide']
	])('refuse %s (%s)', (input) => {
		expect(toE164(input)).toBeNull();
		expect(isPhone(input)).toBe(false);
	});
});

describe('toE164 : autres pays (diaspora, D13)', () => {
	it.each([
		['+33 6 12 34 56 78', '226', '+33612345678'],
		['0033612345678', '226', '+33612345678'],
		['+1 514 555 0123', '226', '+15145550123'],
		['+225 07 08 09 10 11', '226', '+2250708091011'],
		['06 12 34 56 78', '33', '+33612345678'],
		['6 12 34 56 78', '33', '+33612345678'],
		['07 08 09 10 11', '225', '+2250708091011'],
		['514 555 0123', '1', '+15145550123'],
		['020 7946 0958', '44', '+442079460958'],
		['06 1234 5678', '39', '+390612345678']
	])('%s (pays +%s) → %s', (input, country, expected) => {
		expect(toE164(input, country)).toBe(expected);
	});

	it.each([
		['+33 6 12', 'trop court'],
		['+12345678901234567', 'plus de 15 chiffres'],
		['+0612345678', 'indicatif commençant par 0'],
		['06 12 34 56 7x', 'lettre']
	])('refuse %s (%s)', (input) => {
		expect(toE164(input, '33')).toBeNull();
	});
});

describe('affichage et pays', () => {
	it('affiche chaque pays de façon lisible, avec des espaces insécables', () => {
		expect(formatPhone('0022670123456')).toBe(join('+226', '70', '12', '34', '56'));
		expect(formatPhone('+33612345678')).toBe(join('+33', '6', '12', '34', '56', '78'));
		expect(formatPhone('+2250708091011')).toBe(join('+225', '07', '08', '09', '10', '11'));
		expect(formatPhone('+15145550123')).toBe(join('+1', '514', '555', '0123'));
	});
	it('rend une saisie non reconnue telle quelle', () => {
		expect(formatPhone('inconnu')).toBe('inconnu');
	});
	it('retrouve le pays par l’indicatif le plus long', () => {
		expect(countryOf('+22670123456')?.iso).toBe('BF');
		expect(countryOf('+15145550123')?.iso).toBe('US');
		expect(COUNTRIES[0]?.code).toBe('226');
	});
	it('donne les chiffres d’un lien wa.me', () => {
		expect(waNumber('70 12 34 56')).toBe('22670123456');
		expect(waNumber('+33612345678')).toBe('33612345678');
		expect(waNumber('123')).toBeNull();
	});
});

describe('phoneSchema', () => {
	it('normalise en E.164, quel que soit le pays, ou refuse avec un message en français', () => {
		expect(phoneSchema.parse('70 12 34 56')).toBe('+22670123456');
		expect(phoneSchema.parse('+33 6 12 34 56 78')).toBe('+33612345678');
		expect(phoneSchema.safeParse('123').error?.issues[0]?.message).toBe('Numéro de téléphone invalide.');
	});
});
