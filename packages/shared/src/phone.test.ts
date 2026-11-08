import { describe, expect, it } from 'vitest';
import { NBSP } from './money.js';
import { formatPhone, isBfPhone, phoneSchema, toE164, waNumber } from './phone.js';

describe('toE164', () => {
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
		[`+226${NBSP}76${NBSP}01${NBSP}22${NBSP}49`, '+22676012249']
	])('%s → %s', (input, expected) => {
		expect(toE164(input)).toBe(expected);
	});

	it.each([
		['7012345', 'trop court'],
		['701234567', 'trop long'],
		['+33612345678', 'autre pays'],
		['0033612345678', 'autre pays'],
		['80123456', 'série non attribuée'],
		['70 12 34 5a', 'lettre'],
		['', 'vide']
	])('refuse %s (%s)', (input) => {
		expect(toE164(input)).toBeNull();
		expect(isBfPhone(input)).toBe(false);
	});
});

describe('formatPhone et waNumber', () => {
	it('affiche « +226 70 12 34 56 » avec des espaces insécables', () => {
		expect(formatPhone('0022670123456')).toBe(['+226', '70', '12', '34', '56'].join(NBSP));
	});
	it('rend une saisie non reconnue telle quelle', () => {
		expect(formatPhone('inconnu')).toBe('inconnu');
	});
	it('donne les chiffres d’un lien wa.me', () => {
		expect(waNumber('70 12 34 56')).toBe('22670123456');
		expect(waNumber('+33612345678')).toBeNull();
	});
});

describe('phoneSchema', () => {
	it('normalise en E.164 ou refuse avec un message en français', () => {
		expect(phoneSchema.parse('70 12 34 56')).toBe('+22670123456');
		expect(phoneSchema.safeParse('123').error?.issues[0]?.message).toBe('Numéro du Burkina Faso à 8 chiffres attendu.');
	});
});
