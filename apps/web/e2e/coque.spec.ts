/**
 * Coque responsive (docs/UX.md §3 et §8) : pour chaque appareil et chaque profil, la bonne navigation,
 * et aucune autre ; aucun débordement horizontal sur téléphone ; application installable.
 */
import { expect, test, type Page } from '@playwright/test';
import { type Account, expectNoHorizontalOverflow, openOrganization, signIn } from './support';

const phone = { viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true };
const tablet = { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true };
const desktop = { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false };

/**
 * Profils, compte de démonstration, chemin d'accueil, onglets du téléphone, entrées du rail et du menu latéral
 * (docs/UX.md §2). Depuis le lot 03, le profil vient du rôle dans l'organisation active, plus de l'URL.
 */
interface Case {
	name: string;
	account: Account;
	/** Organisation à ouvrir depuis le choix de l'espace (personne membre de plusieurs). */
	org?: string;
	path: string;
	tabs: string[];
	menu: string[];
	sections: string[];
}

const cases: Case[] = [
	{
		name: 'directeur',
		account: 'director',
		path: '/app',
		tabs: ['Accueil', 'Biens', 'Encaissements', 'Plus'],
		menu: [
			'Tableau de bord',
			'Biens et unités',
			'Encaissements',
			'Impayés',
			'Propriétaires',
			'À valider',
			'Équipe',
			'Paramètres de l’organisation',
			'Journal'
		],
		sections: ['Pilotage', 'Gestion', 'Contrôle', 'Agence']
	},
	{
		name: 'gestionnaire',
		account: 'managerB',
		path: '/app',
		tabs: ['Accueil', 'Biens', 'Encaissements', 'Plus'],
		menu: ['Tableau de bord', 'Biens et unités', 'Encaissements', 'Impayés', 'Propriétaires', 'À valider', 'Équipe'],
		sections: ['Pilotage', 'Gestion', 'Contrôle', 'Agence']
	},
	{
		name: 'agent de terrain',
		account: 'fieldAgent',
		path: '/app',
		tabs: ['Tournée', 'Biens', 'Encaissements', 'Plus'],
		menu: ['Ma tournée', 'Mes biens', 'Mes encaissements', 'Retards'],
		sections: ['Terrain']
	},
	{
		name: 'lecture et comptabilité',
		account: 'viewer',
		path: '/app',
		tabs: ['Accueil', 'Biens', 'Encaissements', 'Plus'],
		menu: ['Tableau de bord', 'Biens et unités', 'Encaissements', 'Impayés', 'Propriétaires', 'À valider'],
		sections: ['Pilotage', 'Gestion', 'Contrôle']
	},
	{
		name: 'bailleur particulier',
		account: 'managerAndLandlord',
		org: 'Mes logements',
		path: '/app',
		tabs: ['Accueil', 'Logements', 'Loyers', 'Plus'],
		menu: ['Accueil', 'Mes logements', 'Loyers reçus', 'Retards', 'Paramètres de l’organisation', 'Journal'],
		sections: ['Mes logements']
	},
	{
		name: 'propriétaire',
		account: 'person',
		path: '/espace/proprietaire',
		tabs: ['Patrimoine', 'Revenus', 'Relevés', 'Plus'],
		menu: ['Mon patrimoine', 'Revenus', 'Relevés', 'Reversements', 'Approbations'],
		sections: ['Mon patrimoine']
	},
	{
		name: 'locataire',
		account: 'person',
		path: '/espace/locataire',
		tabs: ['Logement', 'Reçus', 'Caution', 'Plus'],
		menu: ['Mon logement', 'Historique', 'Reçus', 'Caution et décompte', 'Signalements', 'Préavis'],
		sections: ['Mon espace']
	},
	{
		name: 'administrateur plateforme',
		account: 'admin',
		path: '/admin',
		tabs: ['Organisations', 'Abonnements', 'Fonctionnalités', 'Plus'],
		menu: ['Organisations', 'Personnes', 'Formules et abonnements', 'Fonctionnalités', 'Quartiers', 'Journal', 'Accès d’assistance'],
		sections: ['Plateforme', 'Contrôle']
	}
];

/** Ouvre la session du compte du profil, puis son espace. */
async function open(page: Page, c: Case): Promise<void> {
	if (c.org) {
		await signIn(page, c.account, '/espace');
		await openOrganization(page, c.org);
	} else {
		await signIn(page, c.account, c.path);
	}
}

const mainNav = (page: Page) => page.getByRole('navigation', { name: 'Navigation principale' });

async function linkNames(page: Page): Promise<string[]> {
	return (await mainNav(page).getByRole('link').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
}

test.describe('Téléphone (360 × 800)', () => {
	test.use(phone);
	for (const c of cases) {
		test(`${c.name} : barre d’onglets en bas, sans rail ni menu latéral`, async ({ page }) => {
			await open(page, c);
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

	test('« Plus » rassemble les entrées sans onglet, le changement d’espace et le compte', async ({ page }) => {
		await signIn(page, 'director', '/app');
		await mainNav(page).getByRole('link', { name: 'Plus' }).tap();
		const more = page.getByTestId('ecran-plus');
		await expect(more.getByRole('link')).toHaveText([
			'Impayés',
			'Propriétaires',
			'À valider',
			'Équipe',
			'Paramètres de l’organisation',
			'Journal',
			'Changer d’espace',
			'Mon compte'
		]);
		await expect(more.getByRole('button', { name: 'Se déconnecter' })).toBeVisible();
		await more.getByRole('link', { name: 'Impayés' }).tap();
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Impayés');
		await expect(page.getByTestId('ecran-vide')).toContainText('lot 10');
		// « Plus » reste l'onglet actif sur un écran qu'il a ouvert.
		await expect(mainNav(page).getByRole('link', { name: 'Plus' })).toHaveAttribute('aria-current', 'page');
	});

	test('le back-office prévient qu’il est conçu pour l’ordinateur', async ({ page }) => {
		await signIn(page, 'admin', '/admin');
		await expect(page.getByRole('note')).toHaveText('Le back-office est conçu pour l’ordinateur.');
	});

	test('aucun débordement horizontal', async ({ page }) => {
		await signIn(page, 'director', '/app');
		for (const path of [
			'/',
			'/louer',
			'/app',
			'/app/biens',
			'/app/plus',
			'/app/equipe',
			'/app/organisation',
			'/app/journal',
			'/espace',
			'/espace/compte',
			'/espace/appareils',
			'/espace/nouvelle-organisation',
			'/espace/proprietaire',
			'/espace/proprietaire/plus',
			'/espace/locataire',
			'/espace/locataire/caution'
		]) {
			await page.goto(path);
			await expect(page.locator('h1').first()).toBeVisible();
			await expectNoHorizontalOverflow(page, path);
		}
	});

	test('aucun débordement horizontal dans le back-office', async ({ page }) => {
		await signIn(page, 'admin', '/admin');
		for (const path of ['/admin', '/admin/fonctionnalites']) {
			await page.goto(path);
			await expect(page.locator('h1').first()).toBeVisible();
			await expectNoHorizontalOverflow(page, path);
		}
	});
});

test.describe('Tablette (820 × 1180)', () => {
	test.use(tablet);
	for (const c of cases) {
		test(`${c.name} : rail à gauche, sans onglets ni menu latéral`, async ({ page }) => {
			await open(page, c);
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
			await open(page, c);
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

	test('la lecture et comptabilité ne voit pas l’équipe ; l’adresse directe n’affiche rien', async ({ page }) => {
		await signIn(page, 'viewer', '/app');
		await expect(mainNav(page).getByRole('link', { name: 'Équipe' })).toHaveCount(0);
		await page.goto('/app/equipe');
		await expect(page.getByTestId('erreur-formulaire')).toHaveText('Écran introuvable.');
		await expect(page.getByTestId('membre')).toHaveCount(0);
	});

	test('l’entrée du menu suit l’écran ouvert', async ({ page }) => {
		await signIn(page, 'person', '/espace/locataire/caution');
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
		'Formules et abonnements': 'Abonnements',
		'Paramètres de l’organisation': 'Paramètres'
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
				// Gestionnaire de l'agence A, et bailleur de ses propres logements.
				await signIn(page, 'managerAndLandlord', '/espace');
				await expect(page.getByTestId('choix-espace').getByRole('link')).toHaveCount(2);
				await expect(page.getByTestId('espace-organisation')).toHaveText([/Mon agence : Faso Immobilier/, /Mes logements/]);
				await page.getByTestId('espace-owner').click();
				await expect(page).toHaveURL('/espace/proprietaire');
				await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mon patrimoine');
				await openOrganization(page, 'Mes logements');
				await expect(page.getByRole('heading', { level: 1 })).toHaveText('Accueil');
			});
		});
	}

	test('un chemin absent de toute navigation affiche « Écran introuvable »', async ({ page }) => {
		await signIn(page, 'director', '/app/inconnu');
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Écran introuvable.');
	});
});

test.describe('Installation (PWA)', () => {
	test('manifeste installable et service worker actif', async ({ page, request }) => {
		await signIn(page, 'director', '/app');
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
		await signIn(page, 'director', '/app');
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
