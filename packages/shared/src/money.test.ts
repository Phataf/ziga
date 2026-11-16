import { describe, expect, it } from 'vitest';
import { assertFcfa, fcfaSchema, formatFcfa, formatFcfaForPdf, InvalidAmountError, MAX_FCFA, NBSP, parseFcfa, THIN_NBSP } from './money.js';

describe('formatFcfa', () => {
	it('règle 2 : espace fine insécable U+202F entre les milliers, espace insécable U+00A0 avant « FCFA », aucune espace ordinaire', () => {
		expect(THIN_NBSP).toBe('\u202f');
		expect(NBSP).toBe('\u00a0');
		expect(formatFcfa(75_000)).toBe('75\u202f000\u00a0FCFA');
		expect(formatFcfa(1_250_000)).toBe('1\u202f250\u202f000\u00a0FCFA');
		for (const amount of [0, 999, 75_000, 1_250_000, MAX_FCFA]) expect(formatFcfa(amount)).not.toContain(' ');
	});

	it('documents dessinés par pdf-lib (polices standard, sans U+202F) : U+00A0 partout', () => {
		expect(formatFcfaForPdf(75_000)).toBe('75\u00a0000\u00a0FCFA');
		expect(formatFcfaForPdf(1_250_000)).toBe('1\u00a0250\u00a0000\u00a0FCFA');
		expect(formatFcfaForPdf(999)).toBe('999\u00a0FCFA');
	});

	it('sépare les milliers par une espace fine insécable et ajoute FCFA après une espace insécable', () => {
		expect(formatFcfa(75000)).toBe(`75${THIN_NBSP}000${NBSP}FCFA`);
		expect(formatFcfa(0)).toBe(`0${NBSP}FCFA`);
		expect(formatFcfa(999)).toBe(`999${NBSP}FCFA`);
		expect(formatFcfa(1_250_000)).toBe(`1${THIN_NBSP}250${THIN_NBSP}000${NBSP}FCFA`);
	});

	it('formate les très grands montants sans perte (10 milliards de FCFA)', () => {
		expect(formatFcfa(10_000_000_000)).toBe(`10${THIN_NBSP}000${THIN_NBSP}000${THIN_NBSP}000${NBSP}FCFA`);
		expect(formatFcfa(MAX_FCFA)).toBe(`9${THIN_NBSP}007${THIN_NBSP}199${THIN_NBSP}254${THIN_NBSP}740${THIN_NBSP}991${NBSP}FCFA`);
	});

	it('refuse les décimales au lieu d’arrondir', () => {
		expect(() => formatFcfa(75000.5)).toThrow(InvalidAmountError);
		expect(() => formatFcfa(0.1 + 0.2)).toThrow(InvalidAmountError);
	});

	it('refuse les montants négatifs, infinis et non sûrs', () => {
		expect(() => formatFcfa(-5000)).toThrow(InvalidAmountError);
		expect(() => formatFcfa(Number.POSITIVE_INFINITY)).toThrow(InvalidAmountError);
		expect(() => formatFcfa(Number.NaN)).toThrow(InvalidAmountError);
		expect(() => formatFcfa(MAX_FCFA + 1)).toThrow(InvalidAmountError);
		expect(() => assertFcfa('75000')).toThrow(InvalidAmountError);
	});
});

describe('parseFcfa', () => {
	it('lit les saisies usuelles', () => {
		expect(parseFcfa('75000')).toBe(75000);
		expect(parseFcfa('75 000')).toBe(75000);
		expect(parseFcfa(`75${THIN_NBSP}000${NBSP}FCFA`)).toBe(75000);
		expect(parseFcfa('75\u202f000\u00a0FCFA')).toBe(75000);
		expect(parseFcfa('75\u00a0000')).toBe(75000);
		expect(parseFcfa('75.000')).toBe(75000);
		expect(parseFcfa('10 000 000 000')).toBe(10_000_000_000);
	});

	it('refuse les décimales, les négatifs et le texte', () => {
		expect(parseFcfa('75 000,50')).toBeNull();
		expect(parseFcfa('-5000')).toBeNull();
		expect(parseFcfa('')).toBeNull();
		expect(parseFcfa('cinq mille')).toBeNull();
		expect(parseFcfa('99999999999999999')).toBeNull();
	});
});

describe('fcfaSchema', () => {
	it('accepte un entier positif ou nul et refuse le reste avec un message en français', () => {
		expect(fcfaSchema.parse(85000)).toBe(85000);
		expect(fcfaSchema.safeParse(85000.5).error?.issues[0]?.message).toBe('Le montant doit être un entier, sans centimes.');
		expect(fcfaSchema.safeParse(-1).error?.issues[0]?.message).toBe('Le montant ne peut pas être négatif.');
	});
});
