import { describe, expect, it } from 'vitest';
import { fitWithin, precheck } from './photos';

describe('photos sur l’appareil (lot 07)', () => {
	it('le plus grand côté ramené à 1600 px, proportions gardées, jamais agrandi', () => {
		expect(fitWithin(4000, 3000)).toEqual({ width: 1600, height: 1200 });
		expect(fitWithin(3000, 4000)).toEqual({ width: 1200, height: 1600 });
		expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
	});

	it('plus de 10 Mo avant compression : refusé', () => {
		expect(precheck({ size: 10 * 1024 * 1024 })).toBeNull();
		expect(precheck({ size: 10 * 1024 * 1024 + 1 })).toBe('TOO_LARGE');
	});
});
