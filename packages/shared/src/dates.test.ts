import { describe, expect, it } from 'vitest';
import { formatDate, isIsoDate, parseDate, toIsoDate } from './dates.js';

describe('dates', () => {
	it('affiche jj/mm/aaaa', () => {
		expect(formatDate('2026-11-07')).toBe('07/11/2026');
		expect(formatDate(new Date('2026-11-07T23:30:00Z'))).toBe('07/11/2026');
	});
	it('refuse une date qui n’existe pas', () => {
		expect(isIsoDate('2026-02-29')).toBe(false);
		expect(isIsoDate('2028-02-29')).toBe(true);
		expect(() => formatDate('2026-13-01')).toThrow(RangeError);
	});
	it('lit une saisie jj/mm/aaaa', () => {
		expect(parseDate('7/11/2026')).toBe('2026-11-07');
		expect(parseDate('31/04/2026')).toBeNull();
	});
	it('donne la date du jour à Ouagadougou', () => {
		expect(toIsoDate(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12-31');
	});
});
