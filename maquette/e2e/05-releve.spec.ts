import { expect, test } from '@playwright/test';
import { amount, openDemo, tab } from './helpers';

test('Relevé propriétaire : loyers, commission, dépenses, net et envoi du lien', async ({ page }) => {
	await openDemo(page);
	await tab(page, 'Plus');
	await page.getByRole('link', { name: /Propriétaires et relevés/ }).tap();
	await page.getByTestId('liste-proprietaires').getByRole('link', { name: /Issouf Sawadogo/ }).tap();

	const releve = page.getByTestId('releve');
	await expect(releve.getByRole('heading', { name: 'Octobre 2026' })).toBeVisible();
	// Villa (350 000) + App. A1 (85 000) + App. A2 (85 000) encaissés en octobre.
	await expect(page.getByTestId('total-loyers')).toHaveText(amount('520 000 FCFA'));
	await expect(page.getByTestId('commission')).toHaveText(amount('− 52 000 FCFA'));
	await expect(releve).toContainText('Réparation plomberie — App. A1');
	await expect(releve).toContainText('Entretien du jardin');
	// 520 000 − 52 000 − 25 000 − 15 000
	await expect(page.getByTestId('net')).toHaveText(amount('428 000 FCFA'));

	const envoyer = page.getByTestId('envoyer-releve');
	const href = (await envoyer.getAttribute('href'))!;
	expect(href).toMatch(/^https:\/\/wa\.me\/22670451203\?text=/);
	expect(decodeURIComponent(href)).toMatch(/Net à reverser : 428\s000\sFCFA/);

	const popup = page.waitForEvent('popup');
	await envoyer.tap();
	await (await popup).close();
	await expect(page.getByText('Lien envoyé le 07/11/2026')).toBeVisible();

	// Le mois en cours est aussi consultable.
	await page.getByRole('button', { name: /Novembre 2026 \(en cours\)/ }).tap();
	await expect(releve.getByRole('heading', { name: 'Novembre 2026' })).toBeVisible();
});
