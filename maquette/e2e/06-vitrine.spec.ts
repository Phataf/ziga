import { expect, test } from '@playwright/test';
import { amount, openDemo } from './helpers';

test('Vitrine : annonce publique avec prix, quartier, WhatsApp, appel et mention du mandat', async ({ page }) => {
	await openDemo(page, '/vitrine');
	const cartes = page.getByTestId('annonce-carte');
	await expect(cartes).toHaveCount(1);
	await cartes.first().tap();

	const annonce = page.getByTestId('annonce');
	await expect(annonce.getByRole('heading', { level: 1 })).toHaveText('Appartement 3 pièces — Tampouy');
	await expect(annonce).toContainText(amount('110 000 FCFA / mois'));
	await expect(annonce).toContainText('Tampouy, Ouagadougou');
	await expect(annonce).toContainText('Compteur SONABEL individuel');
	await expect(page.getByTestId('mention-mandat')).toHaveText('Géré sous mandat par Immo Démo');
	// Données privées jamais affichées : adresse exacte, propriétaire, locataires.
	await expect(annonce).not.toContainText('Secteur 21');
	await expect(annonce).not.toContainText('Sawadogo');
	// Pas de barre d'onglets de l'application sur la vitrine.
	await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toHaveCount(0);

	const wa = (await page.getByTestId('contact-whatsapp').getAttribute('href'))!;
	expect(wa).toMatch(/^https:\/\/wa\.me\/22670123456\?text=/);
	expect(decodeURIComponent(wa)).toContain('Appartement 3 pièces — Tampouy');
	await expect(page.getByTestId('contact-appel')).toHaveAttribute('href', 'tel:+22670123456');
});

test('Disponibilité toujours exacte : une unité louée ou retirée n’a pas d’annonce', async ({ page }) => {
	await openDemo(page, '/annonce/u2');
	await expect(page.getByTestId('annonce-indisponible')).toBeVisible();

	await page.goto('/biens/p2');
	await page.getByTestId('unite-u4').getByRole('button', { name: 'Retirer' }).tap();
	await page.goto('/annonce/u4');
	await expect(page.getByTestId('annonce-indisponible')).toBeVisible();
});
