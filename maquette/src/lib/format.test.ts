import { describe, expect, it } from 'vitest';
import {
	daysBetween,
	formatDate,
	formatFCFA,
	formatMonth,
	formatNumber,
	formatPhone,
	parseAmount,
	toE164,
	waNumber
} from './format';

const T = ' '; // espace fine insécable
const N = ' '; // espace insécable

describe('formatFCFA', () => {
	it('sépare les milliers par une espace fine insécable', () => {
		expect(formatFCFA(75000)).toBe(`75${T}000${N}FCFA`);
		expect(formatFCFA(1250000)).toBe(`1${T}250${T}000${N}FCFA`);
	});

	it('gère les petits montants et zéro', () => {
		expect(formatFCFA(0)).toBe(`0${N}FCFA`);
		expect(formatFCFA(500)).toBe(`500${N}FCFA`);
		expect(formatFCFA(1000)).toBe(`1${T}000${N}FCFA`);
	});

	it('affiche le signe des montants négatifs', () => {
		expect(formatNumber(-45000)).toBe(`-45${T}000`);
	});

	it('refuse les nombres à virgule', () => {
		expect(() => formatFCFA(75000.5)).toThrow(RangeError);
		expect(() => formatFCFA(Number.NaN)).toThrow(RangeError);
	});
});

describe('parseAmount', () => {
	it('lit une saisie avec ou sans espaces', () => {
		expect(parseAmount('75000')).toBe(75000);
		expect(parseAmount('75 000')).toBe(75000);
		expect(parseAmount(`75${T}000`)).toBe(75000);
	});

	it('refuse les saisies invalides', () => {
		expect(parseAmount('')).toBeNull();
		expect(parseAmount('75,5')).toBeNull();
		expect(parseAmount('-100')).toBeNull();
		expect(parseAmount('abc')).toBeNull();
	});
});

describe('téléphones +226', () => {
	it('normalise en E.164', () => {
		expect(toE164('70 12 34 56')).toBe('+22670123456');
		expect(toE164('+226 70-12-34-56')).toBe('+22670123456');
		expect(toE164('0022670123456')).toBe('+22670123456');
		expect(toE164('22670123456')).toBe('+22670123456');
	});

	it('refuse un numéro qui n’a pas 8 chiffres nationaux', () => {
		expect(toE164('70 12 34')).toBeNull();
		expect(toE164('+33612345678')).toBeNull();
	});

	it('affiche « +226 70 12 34 56 »', () => {
		expect(formatPhone('+22670123456')).toBe(`+226${N}70${N}12${N}34${N}56`);
		expect(formatPhone('76543210')).toBe(`+226${N}76${N}54${N}32${N}10`);
	});

	it('donne le numéro attendu par wa.me', () => {
		expect(waNumber('+22670123456')).toBe('22670123456');
	});
});

describe('dates', () => {
	it('affiche jj/mm/aaaa', () => {
		expect(formatDate('2026-11-07')).toBe('07/11/2026');
		expect(formatDate('2026-01-31')).toBe('31/01/2026');
	});

	it('affiche le mois en toutes lettres', () => {
		expect(formatMonth('2026-08')).toBe('août 2026');
	});

	it('compte les jours entre deux dates', () => {
		expect(daysBetween('2026-10-05', '2026-11-07')).toBe(33);
		expect(daysBetween('2026-11-07', '2026-11-07')).toBe(0);
	});
});
