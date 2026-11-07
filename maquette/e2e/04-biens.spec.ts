import { expect, test } from '@playwright/test';
import { openDemo, tab } from './helpers';

test('Biens : liste, fiche, statut des unités et publication d’une unité libre', async ({ page }) => {
	await openDemo(page);
	await tab(page, 'Biens');

	const biens = page.getByTestId('liste-biens').getByRole('link');
	await expect(biens).toHaveCount(12);
	await page.getByRole('button', { name: 'Saaba', exact: true }).tap();
	await expect(biens).toHaveCount(2);
	await page.getByRole('button', { name: 'Tous' }).tap();

	await biens.filter({ hasText: 'Cour Pissy' }).tap();
	await expect(page.getByRole('heading', { name: 'Cour Pissy' })).toBeVisible();
	await expect(page.getByTestId('unite-u5')).toContainText('Louée');
	const libre = page.getByTestId('unite-u7');
	await expect(libre).toContainText('Libre');

	// Publier : les 4 conditions sont vérifiées et affichées.
	await libre.getByRole('button', { name: 'Publier' }).tap();
	const sheet = page.getByRole('dialog');
	await expect(sheet.getByRole('list', { name: 'Conditions de publication' }).getByRole('listitem')).toHaveCount(4);
	await sheet.getByRole('button', { name: 'Publier' }).tap();
	await expect(sheet.getByText('Annonce en ligne')).toBeVisible();
	await sheet.getByRole('link', { name: 'Voir l’annonce' }).tap();
	await expect(page.getByTestId('annonce')).toContainText('Chambre-salon — Pissy');
	await expect(page.getByTestId('mention-mandat')).toHaveText('Géré sous mandat par Immo Démo');
});

test('Enregistrer n’est pas publier : refus si le mandat n’autorise pas la publication', async ({ page }) => {
	await openDemo(page, '/biens/p11');
	await page.getByTestId('unite-u19').getByRole('button', { name: 'Publier' }).tap();
	await expect(page.getByTestId('refus-publication')).toContainText('Le mandat n’autorise pas la publication.');
	await expect(page.getByRole('dialog').getByRole('button', { name: 'Publier' })).toBeDisabled();
});

test('Une unité réservée ou louée ne se publie pas', async ({ page }) => {
	await openDemo(page, '/biens/p6');
	await expect(page.getByTestId('unite-u12')).toContainText('Réservée : publication impossible');
	await expect(page.getByTestId('unite-u11').getByRole('button', { name: 'Publier' })).toHaveCount(0);
});
