/**
 * Coque responsive (docs/UX.md §3 et §8) : pour chaque appareil et chaque profil, la bonne navigation,
 * et aucune autre ; aucun débordement horizontal sur téléphone ; application installable.
 */
import { expect, test, type Page } from '@playwright/test';

const phone = { viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true };
const tablet = { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true };
const desktop = { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false };

/** Profils, chemin d'accueil, onglets du téléphone, entrées du rail et du menu latéral (docs/UX.md §2). */
const cases = [
	{
		name: 'directeur',
		path: '/app?profil=director',
		tabs: ['Accueil', 'Biens', 'Encaissements', 'Plus'],
		menu: ['Tableau de bord', 'Biens et unités', 'Encaissements', 'Impayés', 'Propriétaires', 'À valider', 'Équipe'],
		sections: ['Pilotage', 'Gestion', 'Contrôle', 'Agence']
	},
	{
		name: 'gestionnaire',
		path: '/app?profil=manager',
		tabs: ['Accueil', 'Biens', 'Encaissements', 'Plus'],
		menu: ['Tableau de bord', 'Biens et unités', 'Encaissements', 'Impayés', 'Propriétaires', 'À valider'],
		sections: ['Pilotage', 'Gestion', 'Contrôle']
	},
	{
		name: 'agent de terrain',
		path: '/app?profil=field_agent',
		tabs: ['Tournée', 'Biens', 'Encaissements', 'Plus'],
		menu: ['Ma tournée', 'Mes biens', 'Mes encaissements', 'Retards'],
		sections: ['Terrain']
	},
	{
		name: 'bailleur particulier',
		path: '/app?profil=landlord',
		tabs: ['Accueil', 'Logements', 'Loyers', 'Plus'],
		menu: ['Accueil', 'Mes logements', 'Loyers reçus', 'Retards'],
		sections: ['Mes logements']
	},
	{
		name: 'propriétaire',
		path: '/espace/proprietaire',
		tabs: ['Patrimoine', 'Revenus', 'Relevés', 'Plus'],
		menu: ['Mon patrimoine', 'Revenus', 'Relevés', 'Reversements', 'Approbations'],
		sections: ['Mon patrimoine']
	},
	{
		name: 'locataire',
		path: '/espace/locataire',
		tabs: ['Logement', 'Reçus', 'Caution', 'Plus'],
		menu: ['Mon logement', 'Historique', 'Reçus', 'Caution et décompte', 'Signalements', 'Préavis'],
		sections: ['Mon espace']
	},
	{
		name: 'administrateur plateforme',
		path: '/admin',
		tabs: ['Organisations', 'Abonnements', 'Fonctionnalités', 'Plus'],
		menu: ['Organisations', 'Formules et abonnements', 'Fonctionnalités', 'Journal', 'Accès d’assistance'],
		sections: ['Plateforme', 'Contrôle']
	}
];

const mainNav = (page: Page) => page.getByRole('navigation', { name: 'Navigation principale' });

async function linkNames(page: Page): Promise<string[]> {
	return (await mainNav(page).getByRole('link').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
}

test.describe('Téléphone (360 × 800)', () => {
	test.use(phone);
	for (const c of cases) {
		test(`${c.name} : barre d’onglets en bas, sans rail ni menu latéral`, async ({ page }) => {
			await page.goto(c.path);
			await expect(page.getByTestId('barre-onglets')).toBeVisible();
			expect(await linkNames(page)).toEqual(c.tabs);
			await expect(page.getByTestId('rail')).toHaveCount(0);
			await expect(page.getByTestId('menu-lateral')).toHaveCount(0);
			await expect(page.getByTestId('barre-haut')).toHaveCount(0);
			// Cibles tactiles d'au moins 44 px.
			for (const h of await mainNav(page)
				.getByRole('link')
				.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) {
				expect(h).toBeGreaterThanOrEqual(44);
			}
		});
	}

	test('« Plus » rassemble les entrées sans onglet et le changement d’espace', async ({ page }) => {
		await page.goto('/app?profil=director');
		await mainNav(page).getByRole('link', { name: 'Plus' }).tap();
		const more = page.getByTestId('ecran-plus');
		await expect(more.getByRole('link')).toHaveText(['Impayés', 'Propriétaires', 'À valider', 'Équipe', 'Changer d’espace']);
		await more.getByRole('link', { name: 'Impayés' }).tap();
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Impayés');
		await expect(page.getByTestId('ecran-vide')).toContainText('lot 10');
		// « Plus » reste l'onglet actif sur un écran qu'il a ouvert.
		await expect(mainNav(page).getByRole('link', { name: 'Plus' })).toHaveAttribute('aria-current', 'page');
	});

	test('le back-office prévient qu’il est conçu pour l’ordinateur', async ({ page }) => {
		await page.goto('/admin');
		await expect(page.getByRole('note')).toHaveText('Le back-office est conçu pour l’ordinateur.');
	});

	test('aucun débordement horizontal', async ({ page }) => {
		for (const path of [
			'/',
			'/louer',
			'/app',
			'/app/biens',
			'/app/plus',
			'/espace',
			'/espace/proprietaire',
			'/espace/proprietaire/plus',
			'/espace/locataire',
			'/espace/locataire/caution',
			'/admin',
			'/admin/fonctionnalites'
		]) {
			await page.goto(path);
			await expect(page.locator('h1').first()).toBeVisible();
			const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
			expect(overflow, path).toBeLessThanOrEqual(0);
		}
	});
});

test.describe('Tablette (820 × 1180)', () => {
	test.use(tablet);
	for (const c of cases) {
		test(`${c.name} : rail à gauche, sans onglets ni menu latéral`, async ({ page }) => {
			await page.goto(c.path);
			await expect(page.getByTestId('rail')).toBeVisible();
			expect(await linkNames(page)).toEqual(c.menu.map((label) => shortOf(label)));
			await expect(page.getByTestId('barre-onglets')).toHaveCount(0);
			await expect(page.getByTestId('menu-lateral')).toHaveCount(0);
			await expect(mainNav(page).getByRole('link', { name: 'Plus', exact: true })).toHaveCount(0);
		});
	}
});

test.describe('Ordinateur (1440 × 900)', () => {
	test.use(desktop);
	for (const c of cases) {
		test(`${c.name} : menu latéral par sections et barre du haut, sans onglets ni rail`, async ({ page }) => {
			await page.goto(c.path);
			const menu = page.getByTestId('menu-lateral');
			await expect(menu).toBeVisible();
			await expect(page.getByTestId('barre-haut')).toBeVisible();
			expect(await linkNames(page)).toEqual(c.menu);
			// Titres de section (paragraphes), à ne pas confondre avec une entrée du même nom.
			for (const s of c.sections) await expect(menu.locator('p').getByText(s, { exact: true })).toBeVisible();
			await expect(page.getByTestId('barre-onglets')).toHaveCount(0);
			await expect(page.getByTestId('rail')).toHaveCount(0);
		});
	}

	test('le gestionnaire ne voit pas l’équipe, réservée au directeur', async ({ page }) => {
		await page.goto('/app?profil=manager');
		await expect(mainNav(page).getByRole('link', { name: 'Équipe' })).toHaveCount(0);
		await page.goto('/app/equipe');
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Écran introuvable.');
	});

	test('l’entrée du menu suit l’écran ouvert', async ({ page }) => {
		await page.goto('/espace/locataire/caution');
		await expect(mainNav(page).getByRole('link', { name: 'Caution et décompte' })).toHaveAttribute('aria-current', 'page');
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Caution et décompte');
		await expect(page).toHaveTitle('Caution et décompte — Ziga');
	});
});

/** Libellé court affiché dans le rail. */
function shortOf(label: string): string {
	const short: Record<string, string> = {
		'Tableau de bord': 'Accueil',
		'Biens et unités': 'Biens',
		'Ma tournée': 'Tournée',
		'Mes biens': 'Biens',
		'Mes encaissements': 'Encaissements',
		'Mes logements': 'Logements',
		'Loyers reçus': 'Loyers',
		'Mon patrimoine': 'Patrimoine',
		'Mon logement': 'Logement',
		'Caution et décompte': 'Caution',
		'Formules et abonnements': 'Abonnements'
	};
	return short[label] ?? label;
}

test.describe('Vitrine, choix de l’espace et chemins inconnus', () => {
	for (const [name, device] of [
		['téléphone', phone],
		['tablette', tablet],
		['ordinateur', desktop]
	] as const) {
		test.describe(name, () => {
			test.use(device);
			test('la vitrine n’a pas de menu d’application, seulement Louer et Acheter', async ({ page }) => {
				await page.goto('/');
				await expect(page.getByTestId('vitrine')).toBeVisible();
				await expect(mainNav(page)).toHaveCount(0);
				await expect(page.getByTestId('entete-vitrine').getByRole('link')).toHaveText(['Louer', 'Acheter']);
			});

			test('le choix de l’espace mène à chaque espace', async ({ page }) => {
				await page.goto('/espace');
				await expect(page.getByTestId('choix-espace').getByRole('link')).toHaveCount(4);
				await page.getByTestId('espace-owner').click();
				await expect(page).toHaveURL('/espace/proprietaire');
				await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mon patrimoine');
				await page.goto('/espace');
				await page.getByTestId('espace-landlord').click();
				await expect(page.getByRole('heading', { level: 1 })).toHaveText('Accueil');
			});
		});
	}

	test('un chemin absent de toute navigation affiche « Écran introuvable »', async ({ page }) => {
		await page.goto('/app/inconnu');
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Écran introuvable.');
	});
});

test.describe('Installation (PWA)', () => {
	test('manifeste installable et service worker actif', async ({ page, request }) => {
		await page.goto('/app');
		const href = await page.locator('link[rel="manifest"]').getAttribute('href');
		const manifest = await (await request.get(href!)).json();
		expect(manifest).toMatchObject({
			name: 'Ziga — Gestion locative',
			short_name: 'Ziga',
			lang: 'fr',
			display: 'standalone',
			start_url: '/app'
		});
		const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
		expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
		expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);
		const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
		expect(scope).toBe('http://localhost:4173/');
	});

	test('l’application s’ouvre hors connexion une fois installée', async ({ page, context }) => {
		await page.goto('/app');
		await page.evaluate(async () => {
			await navigator.serviceWorker.ready;
		});
		await page.reload();
		await context.setOffline(true);
		await page.goto('/app/biens');
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Biens et unités');
		await context.setOffline(false);
	});
});
