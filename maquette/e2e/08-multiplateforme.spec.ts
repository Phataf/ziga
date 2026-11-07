/**
 * Multiplateforme et multiprofil (docs/UX.md) : chaque appareil a sa coque et ses composants,
 * chaque profil son espace, sa navigation et ses données.
 */
import { expect, test } from '@playwright/test';
import { openDemo } from './helpers';

test.describe('Ordinateur (1440 × 900)', () => {
	test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

	test('menu latéral, barre du haut et tableau de bord en grille, sans barre d’onglets', async ({ page }) => {
		await openDemo(page);
		const nav = page.getByRole('navigation', { name: 'Navigation principale' });
		await expect(nav.getByRole('link', { name: 'Tableau de bord' })).toBeVisible();
		await expect(nav.getByRole('link', { name: 'Impayés' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Plus', exact: true })).toHaveCount(0);
		await expect(page.getByTestId('tableau-de-bord')).toBeVisible();
		await expect(page.getByTestId('echeances-du-jour-bureau').getByRole('row')).toHaveCount(3);
	});

	test('recherche globale au clavier : Ctrl+K, un nom, Entrée', async ({ page }) => {
		await openDemo(page);
		await expect(page.getByTestId('ouvrir-recherche')).toBeVisible();
		await page.keyboard.press('Control+k');
		await page.getByRole('combobox').fill('sana');
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('locataire')).toContainText('Fatimata Sana');
		// Vue liste-formulaire : la liste reste à gauche, le locataire choisi est mis en évidence.
		await expect(page.getByTestId('liste-locataires-panneau').locator('[aria-current="page"]')).toContainText('Fatimata Sana');
	});

	test('impayés en tableau, sélection multiple et relances en série', async ({ page }) => {
		await openDemo(page, '/impayes');
		const table = page.getByTestId('tableau-impayes');
		await expect(table.getByRole('row')).toHaveCount(5);
		await page.getByRole('checkbox', { name: 'Tout sélectionner' }).check();
		await page.getByTestId('relancer-selection').click();
		const panel = page.getByRole('dialog', { name: 'Relances en série' });
		await expect(panel.getByRole('listitem')).toHaveCount(4);
		await page.keyboard.press('Escape');
		await expect(panel).toHaveCount(0);
	});

	test('fiche d’un bien : liste à gauche, tableau des unités, menu d’actions au clavier', async ({ page }) => {
		await openDemo(page, '/biens/p2');
		await expect(page.getByTestId('liste-biens-panneau').locator('[aria-current="page"]')).toContainText('Résidence Tampouy');
		const row = page.getByTestId('ligne-unite-u4');
		await expect(row).toContainText('En ligne');
		const menu = row.getByRole('button', { name: /Actions pour/ });
		await menu.focus();
		await page.keyboard.press('ArrowDown');
		await expect(page.getByRole('menuitem', { name: 'Retirer l’annonce' })).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(row).not.toContainText('En ligne');
	});
});

test.describe('Tablette en portrait (820 × 1180)', () => {
	test.use({ viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true });

	test('rail de navigation à gauche ; la liste puis le formulaire, chacun sur toute la largeur', async ({ page }) => {
		await openDemo(page);
		const nav = page.getByRole('navigation', { name: 'Navigation principale' });
		await expect(nav.getByRole('link', { name: 'Encaisser un loyer' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Plus', exact: true })).toHaveCount(0);
		await nav.getByRole('link', { name: 'Encaisser un loyer' }).tap();
		await page.getByTestId('liste-locataires').getByRole('link').first().tap();
		await expect(page.getByLabel('Montant reçu')).toBeVisible();
		await expect(page.getByTestId('liste-locataires-panneau')).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'Choisir le locataire' })).toBeVisible();
	});
});

test.describe('Tablette en paysage (1180 × 820)', () => {
	test.use({ viewport: { width: 1180, height: 820 }, isMobile: true, hasTouch: true });

	test('vue liste-formulaire côte à côte', async ({ page }) => {
		await openDemo(page, '/encaisser');
		await page.getByTestId('liste-locataires').getByRole('link').first().tap();
		await expect(page.getByLabel('Montant reçu')).toBeVisible();
		await expect(page.getByTestId('liste-locataires-panneau')).toBeVisible();
	});
});

test.describe('Profils (téléphone)', () => {
	test('agent de terrain : ses biens seulement, espèces « à valider », puis validation par le gestionnaire', async ({ page }) => {
		await openDemo(page);
		await page.getByTestId('choisir-profil').tap();
		await page.getByRole('button', { name: /Agent de terrain/ }).tap();
		const tabs = page.getByRole('navigation', { name: 'Navigation principale' });
		await expect(tabs.getByRole('link', { name: 'Tournée' })).toBeVisible();

		await tabs.getByRole('link', { name: 'Biens' }).tap();
		await expect(page.getByTestId('liste-biens').getByRole('link')).toHaveCount(3);

		await page.goto('/encaisser');
		await page.getByTestId('liste-locataires').getByRole('link').first().tap();
		await page.getByRole('button', { name: /Valider/ }).tap();
		await expect(page.getByTestId('recu')).toContainText('Espèces à valider par le gestionnaire');

		await page.getByTestId('choisir-profil').tap();
		await page.getByRole('button', { name: /Gestionnaire/ }).tap();
		await page.goto('/encaissements?filtre=a_valider');
		const list = page.getByTestId('liste-encaissements');
		await expect(list.getByRole('listitem')).toHaveCount(1);
		await list.getByRole('button', { name: /Valider l’encaissement/ }).tap();
		await expect(list).toContainText('Aucun encaissement.');
		await page.getByRole('button', { name: /^Validés/ }).tap();
		await expect(list.getByRole('listitem').first()).toContainText('Validé');
	});

	test('propriétaire, locataire et acheteur ont chacun leur espace', async ({ page }) => {
		await openDemo(page, '/proprietaire');
		await expect(page.getByTestId('espace-proprietaire')).toBeVisible();
		await expect(page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('link', { name: 'Relevés' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Encaisser un loyer' })).toHaveCount(0);

		await page.goto('/locataire');
		await expect(page.getByTestId('espace-locataire')).toBeVisible();
		await expect(page.getByTestId('solde-locataire')).toBeVisible();
		await expect(page.getByRole('button', { name: /Payer par Orange Money/ })).toBeDisabled();

		await page.goto('/vitrine?type=achat');
		await expect(page.getByTestId('annonce-vente')).toHaveCount(3);
		await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toHaveCount(0);
	});

	test('aucun débordement horizontal sur téléphone', async ({ page }) => {
		await openDemo(page);
		for (const path of ['/', '/biens', '/biens/p2', '/encaissements', '/impayes', '/encaisser', '/proprietaire', '/locataire', '/vitrine', '/annonce/u4']) {
			await page.goto(path);
			const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
			expect(overflow, path).toBeLessThanOrEqual(0);
		}
	});
});
