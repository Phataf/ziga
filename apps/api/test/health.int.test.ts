/** /health/live et /health/ready, sur la vraie base, le vrai Redis et un stockage local. */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory.js';
import { parseConfig } from '../src/config/env.js';
import { HealthService } from '../src/health/health.service.js';

interface Check {
	status: 'up' | 'down';
	latencyMs: number;
	error?: string;
}
interface ReadyBody {
	status?: string;
	code?: string;
	message?: string;
	checks: Record<'database' | 'redis' | 'storage', Check>;
	details: { checks: Record<'database' | 'redis' | 'storage', Check> };
}

async function start(overrides: Record<string, string> = {}): Promise<{ app: NestExpressApplication; url: string }> {
	const app = await createApp(parseConfig({ ...process.env, ...overrides }));
	await app.listen(0, '127.0.0.1');
	return { app, url: await app.getUrl() };
}

describe('santé avec toutes les dépendances', () => {
	let app: NestExpressApplication;
	let url: string;
	beforeAll(async () => ({ app, url } = await start()));
	afterAll(() => app.close());

	it('/health/live répond sans vérifier les dépendances', async () => {
		const res = await fetch(`${url}/health/live`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: 'ok' });
		expect(res.headers.get('x-request-id')).toBeTruthy();
	});

	it('/health/ready donne l’état de chaque dépendance', async () => {
		const res = await fetch(`${url}/health/ready`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as ReadyBody;
		for (const name of ['database', 'redis', 'storage'] as const)
			expect(body.checks[name]).toMatchObject({ status: 'up', latencyMs: expect.any(Number) });
	});

	it('/health/ready répond 503 dès que l’arrêt commence', async () => {
		app.get(HealthService).shuttingDown = true;
		const res = await fetch(`${url}/health/ready`);
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({ code: 'NOT_READY', message: 'Arrêt en cours.' });
		app.get(HealthService).shuttingDown = false;
	});

	it('renvoie une erreur uniforme pour une route inconnue', async () => {
		const res = await fetch(`${url}/inconnue`);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: 'NOT_FOUND', message: 'Ressource introuvable.' });
	});
});

describe('santé quand PostgreSQL est arrêté', () => {
	let app: NestExpressApplication;
	let url: string;
	// Un port où rien n'écoute : la base est injoignable, comme un serveur arrêté.
	beforeAll(
		async () =>
			({ app, url } = await start({ DATABASE_URL: 'postgres://app_api:x@127.0.0.1:1/ziga_test', HEALTH_CHECK_TIMEOUT_MS: '1500' }))
	);
	afterAll(() => app.close());

	it('/health/live répond toujours (le processus est vivant)', async () => {
		expect((await fetch(`${url}/health/live`)).status).toBe(200);
	});

	it('/health/ready répond 503 et désigne la base', async () => {
		const res = await fetch(`${url}/health/ready`);
		expect(res.status).toBe(503);
		const body = (await res.json()) as ReadyBody;
		expect(body).toMatchObject({ code: 'NOT_READY', message: 'Une dépendance est injoignable.' });
		expect(body.details.checks.database).toMatchObject({ status: 'down', error: expect.any(String) });
		expect(body.details.checks.redis.status).toBe('up');
		expect(body.details.checks.storage.status).toBe('up');
	});
});
