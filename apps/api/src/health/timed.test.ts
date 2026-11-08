import { describe, expect, it } from 'vitest';
import { timed } from './health.service.js';

describe('vérification d’une dépendance', () => {
	it('rend « up » avec la latence', async () => {
		expect(await timed(async () => undefined, 100)).toMatchObject({ status: 'up' });
	});
	it('rend « down » avec la raison, sans lever', async () => {
		expect(await timed(async () => Promise.reject(new Error('connexion refusée')), 100)).toMatchObject({
			status: 'down',
			error: 'connexion refusée'
		});
	});
	it('rend « down » si la vérification dépasse le délai', async () => {
		const r = await timed(() => new Promise(() => undefined), 50);
		expect(r).toMatchObject({ status: 'down', error: 'délai dépassé (50 ms)' });
	});
});
