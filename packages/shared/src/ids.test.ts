import { describe, expect, it } from 'vitest';
import { idSchema, isUuid, isUuidV7, newId } from './ids.js';

describe('identifiants UUIDv7', () => {
	it('génère des UUIDv7 uniques et triables dans l’ordre de création', () => {
		const ids = Array.from({ length: 1000 }, () => newId());
		expect(new Set(ids).size).toBe(1000);
		expect(ids.every(isUuidV7)).toBe(true);
		expect([...ids].sort()).toEqual(ids);
	});

	it('distingue un UUIDv7 d’un autre UUID', () => {
		const v4 = '9b2f6c4e-1f0a-4c7e-8d3b-2a6f5e4d3c2b';
		expect(isUuid(v4)).toBe(true);
		expect(isUuidV7(v4)).toBe(false);
		expect(isUuidV7('pas-un-uuid')).toBe(false);
		expect(idSchema.safeParse(v4).success).toBe(false);
		expect(idSchema.safeParse(newId()).success).toBe(true);
	});
});
