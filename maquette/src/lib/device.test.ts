import { describe, expect, it } from 'vitest';
import { deviceOf } from './device';

describe('deviceOf', () => {
	it('classe les largeurs en téléphone, tablette et ordinateur', () => {
		expect(deviceOf(360)).toBe('phone');
		expect(deviceOf(767)).toBe('phone');
		expect(deviceOf(768)).toBe('tablet');
		expect(deviceOf(1180)).toBe('tablet');
		expect(deviceOf(1280)).toBe('desktop');
		expect(deviceOf(1920)).toBe('desktop');
	});
});
