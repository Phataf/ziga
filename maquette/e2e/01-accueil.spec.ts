import { expect, test } from '@playwright/test';
import { amount, expectTapTarget, openDemo, tab } from './helpers';

test('Accueil : loyers du mois, impayés et échéances du jour', async ({ page }) => {
	await openDemo(page);

	await expect(page.getByText('Aujourd’hui, 07/11/2026')).toBeVisible();
	await expect(page.getByText('Loyers de novembre 2026')).toBeVisible();
	await expect(page.getByTestId('attendu-mois')).toHaveText(amount('1 880 000 FCFA'));
	await expect(page.getByTestId('carte-impayes')).toContainText('4 impayés');

	const today = page.getByTestId('echeances-du-jour').getByRole('link');
	await expect(today).toHaveCount(2);
	await expect(today.first()).toContainText('Fatimata Sana');

	// Barre de 4 onglets, chacun avec son libellé, cibles ≥ 44 px.
	const nav = page.getByRole('navigation', { name: 'Navigation principale' });
	for (const name of ['Accueil', 'Biens', 'Encaissements', 'Plus']) {
		await expect(nav.getByRole('link', { name })).toBeVisible();
	}
	await expectTapTarget(page, 'nav a');

	// Une échéance du jour mène directement à l'encaissement pré-rempli.
	await today.first().tap();
	await expect(page.getByTestId('locataire')).toContainText('Fatimata Sana');
	await expect(page.getByLabel('Montant reçu')).toHaveValue('85000');

	await tab(page, 'Accueil');
	await expect(page.getByRole('link', { name: 'Encaisser un loyer' })).toBeVisible();
});

test('Réinitialiser la démo efface les saisies', async ({ page }) => {
	await openDemo(page, '/encaisser/l2');
	await page.getByRole('button', { name: /Valider/ }).tap();
	await expect(page.getByText('Encaissement enregistré')).toBeVisible();

	await tab(page, 'Accueil');
	await expect(page.getByTestId('echeances-du-jour').getByRole('link')).toHaveCount(1);

	await tab(page, 'Plus');
	await page.getByRole('button', { name: 'Réinitialiser la démo' }).tap();
	await page.getByRole('button', { name: 'Réinitialiser', exact: true }).tap();

	await expect(page).toHaveURL('/');
	await expect(page.getByTestId('echeances-du-jour').getByRole('link')).toHaveCount(2);
});
