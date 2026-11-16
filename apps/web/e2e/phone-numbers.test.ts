/**
 * Générateur de numéros des tests de bout en bout (Vitest, pas Playwright) : 10 000 tirages, tous valides par la règle
 * de l'application, tous distincts, jamais un compte du jeu d'essai ; deux processus n'ont jamais le même numéro.
 */
import { toE164 } from '@ziga/shared/phone';
import { describe, expect, it } from 'vitest';
import { phoneNumberGenerator } from './phone-numbers';

const DRAWS = 10_000;

describe('numéros de téléphone des tests de bout en bout', () => {
	it('10 000 tirages : tous valides par la règle partagée (toE164), tous distincts', () => {
		const next = phoneNumberGenerator(0);
		const drawn = Array.from({ length: DRAWS }, next);
		for (const n of drawn) expect(toE164(n), n).toBe(`+226${n}`);
		expect(new Set(drawn).size).toBe(DRAWS);
	});

	it('jamais un numéro réservé (comptes du jeu d’essai)', () => {
		const reserved = new Set(['70050000', '70050001', '70050002']);
		const drawn = Array.from({ length: DRAWS }, phoneNumberGenerator(0, reserved));
		expect(drawn.filter((n) => reserved.has(n))).toEqual([]);
		expect(drawn[0]).toBe('70050003');
	});

	it('processus différents, plages disjointes, même au-delà de 100 processus', () => {
		const seen = new Set<string>();
		for (const worker of [0, 1, 7, 42, 99, 100, 101, 250]) {
			const next = phoneNumberGenerator(worker);
			for (let i = 0; i < 1_000; i++) {
				const n = next();
				expect(toE164(n), n).not.toBeNull();
				expect(seen.has(n), `${n} (processus ${worker})`).toBe(false);
				seen.add(n);
			}
		}
	});

	it('la série vient de la règle partagée : « 1 » et « 3 » n’en sont pas, et ne sont jamais tirées', () => {
		for (const bad of ['10050000', '30050000']) expect(toE164(bad)).toBeNull();
		for (const worker of [0, 100, 200, 300, 400]) expect(phoneNumberGenerator(worker)()).toMatch(/^[02567]/);
	});

	it('refuse un numéro de processus invalide', () => {
		expect(() => phoneNumberGenerator(-1)).toThrow(RangeError);
		expect(() => phoneNumberGenerator(1.5)).toThrow(RangeError);
	});
});
