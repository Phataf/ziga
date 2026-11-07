import { expect, test } from '@playwright/test';
import { openDemo, tab } from './helpers';

test('Impayés : triés par retard, relance WhatsApp pré-remplie et polie', async ({ page }) => {
	await openDemo(page);
	await tab(page, 'Encaissements');
	await page.getByRole('link', { name: /Impayés : 4/ }).tap();

	const cards = page.getByTestId('impaye');
	await expect(cards).toHaveCount(4);
	await expect(cards.nth(0)).toContainText('Rodrigue Yaméogo');
	await expect(cards.nth(0)).toContainText(/67\sjours de retard/);
	await expect(cards.nth(3)).toContainText('Pauline Kientega');

	const relancer = cards.nth(0).getByRole('link', { name: 'Relancer' });
	const href = (await relancer.getAttribute('href'))!;
	expect(href).toMatch(/^https:\/\/wa\.me\/22676012249\?text=/);
	const text = decodeURIComponent(href.split('text=')[1]);
	expect(text).toContain('Bonjour M. Rodrigue Yaméogo');
	expect(text).toContain('Sauf erreur de notre part');
	expect(text).toContain('septembre 2026, octobre 2026, novembre 2026');
	expect(text).toContain('merci de ne pas tenir compte de ce message');

	const popup = page.waitForEvent('popup');
	await relancer.tap();
	await (await popup).close();
	await expect(cards.nth(0)).toContainText('Relancé le 07/11/2026');

	// « Encaisser » depuis un impayé ouvre l'encaissement du bon locataire.
	await cards.nth(1).getByRole('link', { name: 'Encaisser' }).tap();
	await expect(page.getByTestId('locataire')).toContainText('Hamidou Zoungrana');
});
