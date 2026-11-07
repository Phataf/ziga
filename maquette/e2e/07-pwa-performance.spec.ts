import { expect, test, type Page } from '@playwright/test';
import { DEMO_NOW } from './helpers';

test.use({ serviceWorkers: 'allow' });

async function waitForServiceWorker(page: Page) {
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller) {
			await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
		}
	});
}

test('PWA : manifeste installable et service worker actif', async ({ page, request }) => {
	await page.goto('/');
	await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', /manifest\.webmanifest$/);

	const manifest = await (await request.get('/manifest.webmanifest')).json();
	expect(manifest.display).toBe('standalone');
	expect(manifest.start_url).toBe('/');
	expect(manifest.short_name).toBe('Immo Démo');
	const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
	expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
	for (const icon of manifest.icons) expect((await request.get(icon.src)).ok()).toBe(true);

	await waitForServiceWorker(page);
});

test('Hors connexion : l’application s’ouvre après la première visite', async ({ page, context }) => {
	await page.goto('/');
	await waitForServiceWorker(page);
	await context.setOffline(true);
	await page.goto('/biens/p2');
	await expect(page.getByRole('heading', { name: 'Résidence Tampouy' })).toBeVisible();
	await page.goto('/');
	await expect(page.getByRole('link', { name: 'Encaisser un loyer' })).toBeVisible();
});

test('3G simulée : chaque écran s’affiche en moins d’une seconde après le premier chargement', async ({ page }) => {
	await page.clock.setFixedTime(DEMO_NOW);
	await page.goto('/');
	await waitForServiceWorker(page);

	// Profil « Fast 3G » des outils de développement Chrome.
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Network.enable');
	await cdp.send('Network.emulateNetworkConditions', {
		offline: false,
		latency: 562.5,
		downloadThroughput: (1.6 * 1024 * 1024) / 8 * 0.9,
		uploadThroughput: (750 * 1024) / 8 * 0.9
	});
	await page.reload();
	await expect(page.getByRole('link', { name: 'Encaisser un loyer' })).toBeVisible();

	const screens: { name: string; go: () => Promise<unknown>; ready: () => Promise<unknown> }[] = [
		{
			name: 'Biens',
			go: () => page.getByRole('link', { name: 'Biens' }).tap(),
			ready: () => expect(page.getByTestId('liste-biens')).toBeVisible()
		},
		{
			name: 'Fiche bien',
			go: () => page.getByTestId('liste-biens').getByRole('link').first().tap(),
			ready: () => expect(page.getByRole('heading', { name: 'Villa Ouaga 2000', exact: true })).toBeVisible()
		},
		{
			name: 'Encaissements',
			go: () => page.getByRole('link', { name: 'Encaissements' }).tap(),
			ready: () => expect(page.getByTestId('liste-encaissements')).toBeVisible()
		},
		{
			name: 'Encaisser',
			go: () => page.getByRole('link', { name: 'Encaisser un loyer' }).tap(),
			ready: () => expect(page.getByTestId('liste-locataires')).toBeVisible()
		},
		{
			name: 'Impayés',
			go: () => page.goto('/impayes'),
			ready: () => expect(page.getByTestId('impaye').first()).toBeVisible()
		},
		{
			name: 'Relevé',
			go: () => page.goto('/proprietaires/o1/releve'),
			ready: () => expect(page.getByTestId('releve')).toBeVisible()
		},
		{
			name: 'Vitrine',
			go: () => page.goto('/annonce/u4'),
			ready: () => expect(page.getByTestId('annonce')).toBeVisible()
		}
	];

	for (const s of screens) {
		const start = Date.now();
		await s.go();
		await s.ready();
		const elapsed = Date.now() - start;
		test.info().annotations.push({ type: 'durée', description: `${s.name} : ${elapsed} ms` });
		expect(elapsed, `${s.name} en ${elapsed} ms`).toBeLessThan(1000);
	}
});
