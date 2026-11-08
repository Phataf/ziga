/**
 * Authentification (lot 02), contre la vraie API : inscription, vérification, connexion, rafraîchissement,
 * hors connexion (correction b), appareils, mot de passe oublié, gardes des espaces, trois appareils.
 */
import { expect, test, type Page } from '@playwright/test';
import { accounts, API_URL, expectNoHorizontalOverflow, lastCode, newNational, signIn } from './support';

const phone = { viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true };
const tablet = { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true };
const desktop = { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false };

async function fillRegistration(page: Page, national: string, name = 'Issa Kaboré', password = 'mot-de-passe-solide') {
	await page.getByLabel('Nom complet').fill(name);
	await page.getByLabel('Numéro de téléphone').fill(national);
	await page.getByLabel('Mot de passe', { exact: true }).fill(password);
	await page.getByRole('button', { name: 'Recevoir le code' }).click();
}

test.describe('Téléphone : parcours complet', () => {
	test.use(phone);

	test('inscription, vérification du numéro, déconnexion puis connexion, en moins d’une minute', async ({ page }) => {
		const started = Date.now();
		const national = newNational();
		const e164 = `+226${national}`;
		await page.goto('/inscription');
		// Clavier téléphonique et indicatif +226 affiché.
		await expect(page.getByLabel('Numéro de téléphone')).toHaveAttribute('inputmode', 'tel');
		await expect(page.getByTestId('pays')).toHaveValue('226');
		await expect(page.getByText('+226', { exact: true })).toBeVisible();
		await fillRegistration(page, national);

		await expect(page).toHaveURL(/\/verification\?numero=/);
		await expect(page.getByLabel('Code reçu par SMS')).toHaveAttribute('inputmode', 'numeric');
		await page.getByLabel('Code reçu par SMS').fill(lastCode(e164));
		await page.getByRole('button', { name: 'Vérifier' }).click();

		// Personne sans organisation : son espace personnel, sans erreur.
		await expect(page).toHaveURL('/espace');
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bonjour Issa Kaboré');
		await expect(page.getByTestId('espaces-gestion')).toContainText('Vous n’êtes membre d’aucune organisation.');
		await page.getByTestId('espace-owner').click();
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mon patrimoine');
		await expect(page.getByTestId('ecran-vide')).toBeVisible();

		await page.goto('/espace');
		await page.getByTestId('deconnexion').click();
		await expect(page).toHaveURL('/connexion');
		await page.goto('/espace');
		await expect(page).toHaveURL('/connexion?retour=%2Fespace');

		await page.getByLabel('Numéro de téléphone').fill(national);
		await page.getByLabel('Mot de passe', { exact: true }).fill('mot-de-passe-solide');
		await page.getByRole('button', { name: 'Se connecter' }).click();
		await expect(page).toHaveURL('/espace');
		expect(Date.now() - started).toBeLessThan(60_000);
	});

	test('numéro inconnu et mauvais mot de passe : même message', async ({ page }) => {
		const messages: string[] = [];
		const attempts: [string, string][] = [
			[newNational(), 'un-mot-de-passe'],
			[accounts.person.national, 'mauvais-mot-de-passe']
		];
		for (const [national, password] of attempts) {
			await page.goto('/connexion');
			await page.getByLabel('Numéro de téléphone').fill(national);
			await page.getByLabel('Mot de passe', { exact: true }).fill(password);
			await page.getByRole('button', { name: 'Se connecter' }).click();
			messages.push((await page.getByTestId('erreur-formulaire').innerText()).trim());
		}
		expect(messages[0]).toBe('Numéro ou mot de passe incorrect.');
		expect(messages[1]).toBe(messages[0]);
	});

	test('un numéro invalide est refusé avant tout envoi', async ({ page }) => {
		await page.goto('/connexion');
		await page.getByLabel('Numéro de téléphone').fill('12');
		await page.getByLabel('Mot de passe', { exact: true }).fill('peu-importe');
		await page.getByRole('button', { name: 'Se connecter' }).click();
		await expect(page.getByText('Numéro de téléphone invalide.')).toBeVisible();
	});

	test('un autre pays peut être choisi (diaspora)', async ({ page }) => {
		await page.goto('/inscription');
		await page.getByTestId('pays').selectOption('33');
		await expect(page.getByText('+33', { exact: true })).toBeVisible();
		await fillRegistration(page, `06${newNational().slice(1)}`, 'Fatou Sawadogo');
		await expect(page).toHaveURL(/\/verification\?numero=%2B336/);
	});

	test('sans session, les espaces connectés renvoient vers la connexion, puis vers l’écran demandé', async ({ page }) => {
		for (const path of ['/app', '/espace/proprietaire', '/admin']) {
			await page.goto(path);
			await expect(page).toHaveURL(`/connexion?retour=${encodeURIComponent(path)}`);
		}
		await page.getByLabel('Numéro de téléphone').fill(accounts.person.national);
		await page.getByLabel('Mot de passe', { exact: true }).fill(accounts.person.password);
		await page.getByRole('button', { name: 'Se connecter' }).click();
		await expect(page).toHaveURL('/admin');
		// Une personne sans rôle plateforme n'entre pas dans le back-office.
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Le back-office est réservé à l’équipe de la plateforme.');
	});

	test('la session survit au rechargement (jeton de rafraîchissement en cookie httpOnly)', async ({ page, context }) => {
		await signIn(page, 'director', '/app');
		await page.reload();
		await expect(page.getByTestId('barre-onglets')).toBeVisible();
		await expect(page).toHaveURL('/app');
		const cookie = (await context.cookies(API_URL)).find((c) => c.name === '__Host-ziga_rt');
		expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
		// Le jeton d'accès n'est jamais écrit dans le stockage du navigateur.
		const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
		expect(stored).not.toMatch(/eyJ[\w-]+\.[\w-]+\./);
		expect(stored).not.toContain(accounts.person.phone);
	});

	test('hors connexion : la coque s’affiche au rechargement, sans renvoi vers la connexion', async ({ page, context }) => {
		await signIn(page, 'director', '/app');
		await page.evaluate(async () => {
			await navigator.serviceWorker.ready;
		});
		await page.reload();
		await expect(page.getByTestId('barre-onglets')).toBeVisible();
		await context.setOffline(true);
		await page.reload();
		await expect(page.getByTestId('barre-onglets')).toBeVisible();
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tableau de bord');
		await expect(page).toHaveURL('/app');
		// Au retour du réseau, la session se renouvelle d'elle-même.
		await context.setOffline(false);
		await page.goto('/espace/appareils');
		await expect(page.getByTestId('appareil-courant')).toBeVisible();
	});

	test('session refusée par le serveur (401) : renvoi vers la connexion', async ({ page, context }) => {
		await signIn(page, 'director', '/app');
		await context.clearCookies();
		await page.reload();
		await expect(page).toHaveURL('/connexion?retour=%2Fapp');
		expect(await page.evaluate(() => localStorage.getItem('ziga:derniere-session'))).toBeNull();
	});

	test('mot de passe oublié : code par SMS, nouveau mot de passe, connecté', async ({ page, request }) => {
		const national = newNational();
		const e164 = `+226${national}`;
		expect(
			(
				await request.post(`${API_URL}/auth/register`, { data: { phone: e164, name: 'Mariam Zongo', password: 'ancien-mot-de-passe' } })
			).status()
		).toBe(202);
		expect((await request.post(`${API_URL}/auth/verify-phone`, { data: { phone: e164, code: lastCode(e164) } })).status()).toBe(200);

		await page.goto('/connexion');
		await page.getByRole('link', { name: 'Mot de passe oublié ?' }).click();
		await page.getByLabel('Numéro de téléphone').fill(national);
		await page.getByRole('button', { name: 'Recevoir le code' }).click();
		// Le code n'est lu qu'une fois l'envoi terminé (l'écran suivant affiché).
		await expect(page.getByLabel('Code reçu par SMS')).toBeVisible();
		await page.getByLabel('Code reçu par SMS').fill(lastCode(e164));
		await page.getByLabel('Nouveau mot de passe').fill('nouveau-mot-de-passe');
		await page.getByRole('button', { name: 'Enregistrer et se connecter' }).click();
		await expect(page).toHaveURL('/espace');
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bonjour Mariam Zongo');
	});
});

test.describe('Mes appareils', () => {
	test.use(desktop);

	test('liste des appareils et déconnexion d’un autre appareil', async ({ page, browser }) => {
		const other = await browser.newContext({ ...phone, userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/140.0 Mobile Safari/537.36' });
		const otherPage = await other.newPage();
		await signIn(otherPage, 'admin', '/admin');

		await signIn(page, 'admin', '/espace/appareils');
		await expect(page.getByTestId('appareil-courant')).toBeVisible();
		const device = page.getByTestId('appareil').filter({ hasText: 'Android' }).first();
		await expect(device).toBeVisible();
		await device.getByRole('button', { name: 'Déconnecter' }).click();
		await expect(page.getByText('Appareil déconnecté.')).toBeVisible();

		// L'appareil déconnecté est renvoyé vers la connexion à son prochain rafraîchissement.
		await otherPage.reload();
		await expect(otherPage).toHaveURL('/connexion?retour=%2Fadmin');
		await other.close();
	});
});

for (const [name, device] of [
	['téléphone', phone],
	['tablette', tablet],
	['ordinateur', desktop]
] as const) {
	test.describe(`Écrans d’authentification (${name})`, () => {
		test.use(device);

		test('chaque écran s’affiche sans débordement horizontal, avec des cibles de 44 px', async ({ page }) => {
			for (const path of ['/connexion', '/inscription', '/mot-de-passe-oublie', '/verification?numero=%2B22670123456']) {
				await page.goto(path);
				await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
				await expectNoHorizontalOverflow(page, path);
				for (const h of await page
					.locator('form button, form input')
					.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) {
					expect(h, path).toBeGreaterThanOrEqual(44);
				}
			}
			await signIn(page, 'person', '/espace/appareils');
			await expect(page.getByTestId('appareil-courant')).toBeVisible();
			await expectNoHorizontalOverflow(page, '/espace/appareils');
		});

		test('le compte est accessible depuis la coque', async ({ page }) => {
			await signIn(page, 'person', '/espace/locataire');
			if (name === 'téléphone') await page.goto('/espace/locataire/plus');
			await page.getByRole('link', { name: 'Mon compte' }).click();
			await expect(page).toHaveURL('/espace/compte');
			await page.getByRole('link', { name: 'Mes appareils' }).click();
			await expect(page).toHaveURL('/espace/appareils');
		});
	});
}
