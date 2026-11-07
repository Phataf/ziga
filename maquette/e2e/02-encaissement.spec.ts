import { expect, test } from '@playwright/test';
import { amount, openDemo, tab } from './helpers';

test('Encaisser en 3 gestes : locataire → montant pré-rempli → valider, puis reçu WhatsApp', async ({ page }) => {
	await openDemo(page);
	await page.getByRole('link', { name: 'Encaisser un loyer' }).tap();

	// Geste 1 : chercher et choisir le locataire.
	await page.getByPlaceholder('Nom, logement ou quartier').fill('sana');
	const list = page.getByTestId('liste-locataires').getByRole('link');
	await expect(list).toHaveCount(1);
	await list.first().tap();

	// Geste 2 : le montant est pré-rempli (clavier numérique), espèces par défaut.
	const montant = page.getByLabel('Montant reçu');
	await expect(montant).toHaveValue('85000');
	await expect(montant).toHaveAttribute('inputmode', 'numeric');
	await expect(page.getByRole('radio', { name: 'Espèces' })).toBeChecked();

	// Geste 3 : valider.
	await page.getByRole('button', { name: /Valider 85\s000\sFCFA/ }).tap();

	await expect(page.getByText('Encaissement enregistré')).toBeVisible();
	const recu = page.getByTestId('recu');
	await expect(recu).toContainText('Fatimata Sana');
	await expect(page.getByTestId('montant-recu')).toHaveText(amount('85 000 FCFA'));
	await expect(page.getByTestId('numero-recu')).toHaveText(/^R-2026-\d{5}$/);
	await expect(recu.getByRole('img', { name: 'QR code de vérification du reçu' }).locator('svg')).toBeVisible();
	await expect(recu).toContainText('Locataire à jour');

	const wa = page.getByTestId('envoyer-whatsapp');
	const href = (await wa.getAttribute('href'))!;
	expect(href).toMatch(/^https:\/\/wa\.me\/22676884120\?text=/);
	const text = decodeURIComponent(href.split('text=')[1]);
	expect(text).toContain('Bonjour Mme Fatimata Sana');
	expect(text).toMatch(/85\s000\sFCFA en espèces le 07\/11\/2026/);

	// L'encaissement apparaît dans la liste et survit à un rechargement.
	await tab(page, 'Encaissements');
	await expect(page).toHaveURL('/encaissements');
	await page.reload();
	await expect(page.getByTestId('liste-encaissements').getByRole('link').first()).toContainText('Fatimata Sana');
});

test('Mobile Money déclaré : référence obligatoire et reçu « à rapprocher »', async ({ page }) => {
	await openDemo(page, '/encaisser/l8');
	await page.getByText('Orange Money').tap();
	const valider = page.getByRole('button', { name: /Valider/ });
	await expect(valider).toBeDisabled();
	await page.getByLabel(/Référence de la transaction/).fill('PP261107.1532.A12345');
	await valider.tap();

	await expect(page.getByTestId('recu')).toContainText('REÇU DE LOYER PROVISOIRE');
	await expect(page.getByTestId('recu')).toContainText('Paiement Mobile Money à rapprocher');
	await expect(page.getByTestId('recu')).toContainText('réf. PP261107.1532.A12345');
});

test('Paiement partiel : imputé sur l’échéance la plus ancienne', async ({ page }) => {
	await openDemo(page, '/encaisser/l4');
	const montant = page.getByLabel('Montant reçu');
	await expect(montant).toHaveValue('60000');
	await montant.fill('30000');
	const imputation = page.getByTestId('imputation');
	await expect(imputation.getByRole('listitem').nth(0)).toHaveText(/octobre 2026\s+20\s000\sFCFA$/);
	await expect(imputation.getByRole('listitem').nth(1)).toHaveText(/novembre 2026\s+10\s000\sFCFA \(partiel\)$/);
	await page.getByRole('button', { name: /Valider 30\s000/ }).tap();
	await expect(page.getByTestId('recu')).toContainText(/Reste dû : 30\s000\sFCFA/);
});
