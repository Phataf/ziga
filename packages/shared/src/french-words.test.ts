import { describe, expect, it } from 'vitest';
import { amountInFrenchWords, dateInFrenchWords, numberInFrenchWords } from './french-words.js';

describe('numberInFrenchWords (orthographe traditionnelle)', () => {
	it.each([
		[0, 'zéro'],
		[1, 'un'],
		[16, 'seize'],
		[17, 'dix-sept'],
		[21, 'vingt et un'],
		[22, 'vingt-deux'],
		[61, 'soixante et un'],
		[70, 'soixante-dix'],
		[71, 'soixante et onze'],
		[77, 'soixante-dix-sept'],
		[80, 'quatre-vingts'],
		[81, 'quatre-vingt-un'],
		[90, 'quatre-vingt-dix'],
		[91, 'quatre-vingt-onze'],
		[99, 'quatre-vingt-dix-neuf'],
		[100, 'cent'],
		[101, 'cent un'],
		[180, 'cent quatre-vingts'],
		[200, 'deux cents'],
		[201, 'deux cent un'],
		[280, 'deux cent quatre-vingts'],
		[1_000, 'mille'],
		[1_001, 'mille un'],
		[2_000, 'deux mille'],
		[21_000, 'vingt et un mille'],
		[75_000, 'soixante-quinze mille'],
		[80_000, 'quatre-vingt mille'],
		[180_000, 'cent quatre-vingt mille'],
		[200_000, 'deux cent mille'],
		[1_000_000, 'un million'],
		[2_000_000, 'deux millions'],
		[80_000_000, 'quatre-vingts millions'],
		[200_000_000, 'deux cents millions'],
		[1_250_000, 'un million deux cent cinquante mille'],
		[999_999_999, 'neuf cent quatre-vingt-dix-neuf millions neuf cent quatre-vingt-dix-neuf mille neuf cent quatre-vingt-dix-neuf'],
		[1_000_000_000, 'un milliard'],
		[3_000_200_001, 'trois milliards deux cent mille un']
	])('%i → %s', (n, words) => {
		expect(numberInFrenchWords(n)).toBe(words);
	});

	it('jusqu’au plus grand montant représentable, sans « undefined »', () => {
		const words = numberInFrenchWords(Number.MAX_SAFE_INTEGER);
		expect(words.startsWith('neuf billiards sept billions')).toBe(true);
		expect(words).not.toMatch(/undefined|NaN/);
	});

	it('refuse les décimales, les négatifs et les valeurs non sûres', () => {
		expect(() => numberInFrenchWords(1.5)).toThrow(RangeError);
		expect(() => numberInFrenchWords(-1)).toThrow(RangeError);
		expect(() => numberInFrenchWords(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
	});
});

describe('amountInFrenchWords', () => {
	it.each([
		[0, 'zéro franc CFA'],
		[1, 'un franc CFA'],
		[21, 'vingt et un francs CFA'],
		[71, 'soixante et onze francs CFA'],
		[80, 'quatre-vingts francs CFA'],
		[81, 'quatre-vingt-un francs CFA'],
		[91, 'quatre-vingt-onze francs CFA'],
		[100, 'cent francs CFA'],
		[180, 'cent quatre-vingts francs CFA'],
		[200, 'deux cents francs CFA'],
		[1_000, 'mille francs CFA'],
		[2_000, 'deux mille francs CFA'],
		[75_000, 'soixante-quinze mille francs CFA'],
		[80_000, 'quatre-vingt mille francs CFA'],
		[1_000_000, 'un million de francs CFA'],
		[3_000_000, 'trois millions de francs CFA'],
		[1_250_000, 'un million deux cent cinquante mille francs CFA'],
		[
			999_999_999,
			'neuf cent quatre-vingt-dix-neuf millions neuf cent quatre-vingt-dix-neuf mille neuf cent quatre-vingt-dix-neuf francs CFA'
		],
		[2_000_000_000, 'deux milliards de francs CFA']
	])('%i → %s', (n, words) => {
		expect(amountInFrenchWords(n)).toBe(words);
	});
});

describe('dateInFrenchWords (documents)', () => {
	it.each([
		['2027-01-01', '1er janvier 2027'],
		['2026-12-15', '15 décembre 2026'],
		['2027-08-31', '31 août 2027'],
		['2028-02-29', '29 février 2028']
	])('%s → %s', (iso, words) => {
		expect(dateInFrenchWords(iso)).toBe(words);
	});

	it('refuse une date mal formée', () => {
		expect(() => dateInFrenchWords('15/12/2026')).toThrow(RangeError);
		expect(() => dateInFrenchWords('2026-13-01')).toThrow(RangeError);
	});
});
