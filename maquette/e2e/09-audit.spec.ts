/**
 * Lot 00 ter : écrans issus de l'audit du 08/11/2026 (D12 à D19).
 * Chaque parcours est joué sur téléphone (360 × 800), tablette (820 × 1180) et ordinateur (1440 × 900).
 */
import { expect, test, type Page } from '@playwright/test';
import { amount, openDemo } from './helpers';

const devices = [
	{ name: 'téléphone', use: { viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true } },
	{ name: 'tablette', use: { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true } },
	{ name: 'ordinateur', use: { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false } }
] as const;

/** Une option d'un groupe de grosses réponses (bouton radio masqué dans son libellé). */
async function choose(page: Page, text: string | RegExp) {
	await page.locator('label').filter({ hasText: text }).first().click();
}

/** Carte d'unité (téléphone, tablette) ou ligne du tableau (ordinateur). */
function unitBox(page: Page, id: string) {
	return page.locator(`[data-testid="unite-${id}"], [data-testid="ligne-unite-${id}"]`);
}

for (const d of devices) {
	test.describe(`Audit — ${d.name}`, () => {
		test.use(d.use);

		test('statut en quatre dimensions : occupation calculée, pastille de synthèse sur les listes', async ({ page }) => {
			await openDemo(page, '/biens');
			await expect(page.getByTestId('resume-parc')).toContainText('1 en préavis');
			await expect(page.getByTestId('resume-parc')).toContainText('2 réservée');

			await page.goto('/biens/p10');
			await expect(unitBox(page, 'u17')).toContainText('En préavis, libre le 30/11/2026');
			await page.goto('/biens/p6');
			await expect(unitBox(page, 'u12')).toContainText('Réservée, entrée le 01/12/2026');

			await page.goto('/biens/p10/u17');
			const fiche = page.getByTestId('fiche-unite');
			await expect(page.getByTestId('synthese-unite')).toHaveText('En préavis, libre le 30/11/2026');
			const dims = page.getByTestId('dimensions-u17');
			for (const t of ['Fiche active', 'En préavis', 'calculée à partir des baux', 'Prête', 'Non publiée']) await expect(dims).toContainText(t);
			await expect(page.getByTestId('preavis')).toContainText('Mutation professionnelle');
			await expect(page.getByTestId('chronologie-unite')).toContainText('Préavis donné par le locataire');
			await expect(fiche).toContainText('100 000');
		});

		test('assistant d’ajout de bien en cinq étapes, brouillon repris, enregistré sans être publié', async ({ page }) => {
			await openDemo(page, '/biens');
			await page.getByTestId('ajouter-bien').click();
			const wizard = page.getByTestId('assistant-bien');
			await expect(wizard.getByRole('heading', { name: 'Type et propriétaire' })).toBeVisible();
			await expect(page.getByTestId('etape-suivante')).toBeDisabled();
			await choose(page, 'Cour commune');
			await choose(page, /Issouf Sawadogo/);
			await page.getByTestId('etape-suivante').click();

			await expect(wizard.getByRole('heading', { name: 'Localisation' })).toBeVisible();
			await page.getByTestId('quartier').fill('Kalgondin');
			await page.getByRole('button', { name: 'Prendre le point GPS ici' }).click();
			await expect(page.getByText(/Point enregistré/)).toBeVisible();
			await expect(page.getByTestId('nom-bien')).toHaveValue('Cour commune Kalgondin');
			await page.getByTestId('etape-suivante').click();

			// Brouillon : on quitte, on revient, on reprend à la même étape.
			await expect(wizard.getByRole('heading', { name: 'Unités' })).toBeVisible();
			await page.goto('/biens/nouveau');
			await expect(page.getByTestId('reprise-brouillon')).toBeVisible();
			await page.getByRole('button', { name: 'Reprendre le brouillon' }).click();
			await expect(wizard.getByRole('heading', { name: 'Unités' })).toBeVisible();

			await page.getByTestId('loyer-unite').fill('40000');
			await expect(page.getByTestId('unite-saisie')).toContainText(amount('80 000 FCFA'));
			await page.getByTestId('etape-suivante').click();
			for (let i = 0; i < 3; i++) await page.getByTestId('ajouter-photo').click();
			await expect(page.getByText(/3 photos/)).toBeVisible();
			await page.getByTestId('etape-suivante').click();

			await expect(page.getByTestId('etat-fiche')).toContainText('active');
			await page.getByTestId('terminer').click();
			await expect(page.getByTestId('bien-enregistre')).toContainText('Rien n’est publié');
			await expect(page.getByRole('heading', { name: 'Cour commune Kalgondin' })).toBeVisible();
			await expect(page.locator('[data-testid^="unite-np-"], [data-testid^="ligne-unite-np-"]').first()).toContainText('Disponible');

			await page.goto('/vitrine');
			await expect(page.getByTestId('annonce-carte')).toHaveCount(1);
		});

		test('sortie du locataire : préavis, état des lieux, décompte 100 000 − 10 000 − 5 000 = 85 000 et ses variantes', async ({ page }) => {
			await openDemo(page, '/sorties');
			await page.getByTestId('sortie-l14').getByRole('link', { name: /Préparer la sortie/ }).click();
			await expect(page.getByTestId('preavis-recap')).toContainText('31/08/2026');
			await expect(page.getByTestId('preavis-recap')).toContainText('30/11/2026');
			await page.getByTestId('etape-suivante').click();

			// État des lieux guidé pièce par pièce, comparé à l'entrée.
			await page.getByRole('button', { name: /^Douche/ }).click();
			await expect(page.getByTestId('piece')).toContainText('Pièce 4 sur 5 : Douche');
			await expect(page.getByTestId('element-douche-pommeau-et-flexible')).toContainText('Neufs à l’entrée');
			await expect(page.getByTestId('etape-suivante')).toBeDisabled();
			await page.getByLabel('Signé par Mme Mariétou Sorgho').check();
			await page.getByLabel('Signé par Immo Démo').check();
			await page.getByTestId('etape-suivante').click();

			// A. Restitution après réparations : l'exemple du porteur.
			const restituer = page.getByTestId('a-restituer');
			await expect(restituer).toHaveText(amount('85 000 FCFA'));
			await expect(page.getByTestId('ligne-decompte')).toHaveCount(2);

			// B. Caution imputée sur le dernier loyer : accord écrit daté avant le mois.
			await choose(page, 'Caution imputée sur les derniers loyers');
			await expect(page.getByTestId('reste-degats')).toContainText(amount('il restera 30 000 FCFA'));
			await expect(page.getByTestId('refus-retenues')).toContainText('pas encore accepté');
			await expect(restituer).toHaveText(amount('85 000 FCFA'));
			await page.getByTestId('accord-imputation').getByRole('button', { name: 'Accepter' }).click();
			await expect(page.getByTestId('accord-imputation')).toContainText('Accepté le 07/11/2026');
			await expect(restituer).toHaveText(amount('15 000 FCFA'));

			// C. Réparations faites par le locataire, après accord et contre-visite.
			await choose(page, 'Réparations faites par le locataire');
			await page.getByTestId('accord-reparation').getByRole('button', { name: 'Accepter' }).click();
			await page.getByLabel(/Contre-visite faite/).check();
			await expect(restituer).toHaveText(amount('100 000 FCFA'));

			await choose(page, 'Restitution après réparations');
			await expect(restituer).toHaveText(amount('85 000 FCFA'));
			await page.getByTestId('etape-suivante').click();
			await expect(page.getByTestId('recapitulatif')).toContainText('à remettre en état');
			await page.getByTestId('terminer').click();

			await expect(page.getByTestId('restitue')).toHaveText(amount('85 000 FCFA'));
			const mvts = page.getByTestId('mouvements-caution');
			await expect(mvts).toContainText(amount('Retenue pour réparation : 10 000 FCFA'));
			await expect(mvts).toContainText(amount('Restitution : 85 000 FCFA'));

			// La fin du bail fait passer l'unité « à remettre en état », jamais directement « disponible ».
			await page.goto('/biens/p10/u17');
			await expect(page.getByTestId('synthese-unite')).toHaveText('À remettre en état');
			await page.getByRole('button', { name: 'Lancer les travaux' }).click();
			await expect(page.getByTestId('synthese-unite')).toHaveText('En travaux');
			await page.getByRole('button', { name: /Travaux terminés/ }).click();
			await expect(page.getByTestId('synthese-unite')).toHaveText('Disponible');
		});

		test('espace propriétaire : patrimoine groupé par gestionnaire, fiche bien, revenus', async ({ page }) => {
			await openDemo(page, '/proprietaire');
			const space = page.getByTestId('espace-proprietaire');
			await expect(space.getByTestId('gestionnaire')).toHaveCount(3);
			await expect(space).toContainText('Horizon Immo');
			await expect(space).toContainText('Immo Démo');
			await expect(space).toContainText('Gestion directe');
			await expect(page.getByTestId('occupation')).toHaveText('5 / 7');
			await page.getByRole('button', { name: 'Gestion directe', exact: true }).click();
			await expect(space.getByTestId('gestionnaire')).toHaveCount(1);
			await expect(space).toContainText('À remettre en état');
			await page.getByRole('button', { name: 'Tous', exact: true }).click();

			await space.getByTestId('bien-proprietaire').filter({ hasText: 'Maison Kossodo' }).click();
			const fiche = page.getByTestId('fiche-bien-proprietaire');
			await expect(fiche).toContainText('Horizon Immo');
			await expect(page.getByTestId('rendement')).toHaveText('7,2 %');
			await expect(fiche).toContainText('détenue par vous');
			await expect(fiche).not.toContainText('Daouda Kinda'); // pas l'identité du locataire

			await page.goto('/proprietaire/revenus');
			await expect(page.getByTestId('net-mois')).toHaveCount(3);
			await expect(page.getByTestId('revenus-proprietaire')).toContainText('Horizon Immo');

			await page.goto('/proprietaire/releves');
			await page.getByRole('button', { name: 'Horizon Immo', exact: true }).click();
			await expect(page.getByTestId('releve')).toContainText('Horizon Immo');
		});

		test('espace locataire : deux baux dans deux agences, caution et décompte, signalement suivi', async ({ page }) => {
			await openDemo(page, '/locataire');
			await page.getByTestId('lien-historique').click();
			const history = page.getByTestId('historique-locataire');
			await expect(history.getByTestId('bail-historique')).toHaveCount(2);
			await expect(history.getByTestId('bail-historique').first()).toContainText('Immo Démo');
			await expect(history.getByTestId('bail-historique').last()).toContainText('Horizon Immo');
			await expect(history).not.toContainText('Boris Tiendrébéogo');

			await page.goto('/locataire/caution');
			await expect(page.getByTestId('caution-en-cours')).toHaveText(amount('70 000 FCFA'));
			const decompte = page.getByTestId('decompte-passe');
			await expect(decompte).toContainText('Douche — pommeau et flexible cassés');
			await expect(decompte).toContainText('Devis du plombier');
			await expect(page.getByTestId('restitution')).toHaveText(amount('85 000 FCFA'));

			await page.goto('/locataire/recus');
			await expect(page.getByTestId('recus-locataire').getByTestId('organisation').first()).toHaveText('Horizon Immo');

			await page.goto('/locataire/signalements');
			await page.getByTestId('details-signalement').fill('Le robinet de la cuisine fuit');
			await page.getByRole('button', { name: 'Envoyer la demande' }).click();
			const first = page.getByTestId('liste-signalements').getByRole('listitem').first();
			await expect(first).toContainText('Le robinet de la cuisine fuit');
			await expect(first).toContainText('Reçue');
		});

		test('back-office : organisations, interrupteurs avec motif et journal, accès d’assistance motivé', async ({ page }) => {
			await openDemo(page, '/admin');
			await page.getByTestId('organisation-agency-horizon').click();
			const states = page.getByTestId('etat-fonctionnalites');
			await expect(states).toContainText('Oui — exception jusqu’au 31/12/2026');
			await expect(states).toContainText('Non — formule Découverte');
			await page.keyboard.press('Escape');

			await page.goto('/admin/fonctionnalites');
			await page.getByTestId('interrupteur-listings.publication').getByRole('button', { name: 'Coupée pour tous' }).click();
			const dialog = page.getByRole('dialog');
			await expect(dialog).toContainText('3 organisations perdront l’accès');
			await expect(dialog.getByRole('button', { name: 'Confirmer' })).toBeDisabled();
			await page.getByTestId('motif-interrupteur').fill('Incident sur la vitrine');
			await dialog.getByRole('button', { name: 'Confirmer' }).click();
			await expect(page.getByTestId('interrupteur-listings.publication').getByRole('button', { name: 'Coupée pour tous' })).toHaveAttribute('aria-pressed', 'true');

			await page.goto('/admin/journal');
			await expect(page.getByTestId('admin-journal')).toContainText('Interrupteur listings.publication — motif : Incident sur la vitrine');

			await page.goto('/admin/assistance');
			await page.getByRole('button', { name: 'Ouvrir l’accès en lecture' }).click();
			await expect(page.getByRole('alert')).toContainText('Choisissez l’organisation.');
			await page.getByTestId('organisation-acces').selectOption('agency-demo');
			await page.getByTestId('motif-acces').fill('Demande de l’agence : relevé d’octobre introuvable');
			await page.getByRole('button', { name: 'Ouvrir l’accès en lecture' }).click();
			await expect(page.getByTestId('liste-acces')).toContainText('relevé d’octobre introuvable');
			await expect(page.getByTestId('liste-acces')).toContainText('lecture seule');
		});

		test('choix de l’espace : une personne, plusieurs espaces, jamais deux organisations sur un écran de gestion', async ({ page }) => {
			await openDemo(page, '/espaces');
			await expect(page.getByTestId('espace-owner')).toContainText('Immo Démo, Horizon Immo, gestion directe');
			await page.getByTestId('espace-landlord').click();
			await expect(page).toHaveURL('/');
			await page.goto('/biens');
			await expect(page.getByTestId('liste-biens').getByRole('link')).toHaveCount(1);
			await expect(page.getByTestId('liste-biens')).toContainText('Résidence Larlé');
			await expect(page.getByTestId('liste-biens')).not.toContainText('Villa Ouaga 2000');

			// Le logement à remettre en état ne se publie pas.
			await page.goto('/biens/cp1');
			await unitBox(page, 'cu2').getByRole('button', { name: 'Publier' }).click();
			await expect(page.getByTestId('refus-publication')).toContainText('pas prête');
			await page.keyboard.press('Escape');

			await page.goto('/espaces');
			await page.getByTestId('espace-owner').click();
			await expect(page).toHaveURL('/proprietaire');
			await expect(page.getByTestId('espace-proprietaire')).toBeVisible();
		});
	});
}

test('aucune retenue sans justificatif : la ligne est refusée et la caution reste due', async ({ page }) => {
	await openDemo(page, '/sorties/l14');
	await page.getByTestId('etape-suivante').click();
	await page.getByRole('button', { name: /^Douche/ }).click();
	await page.getByTestId('element-douche-pommeau-et-flexible').getByRole('button', { name: 'Retirer' }).click();
	await expect(page.getByTestId('element-douche-pommeau-et-flexible').getByRole('alert')).toContainText('justificatif manquant');
	await page.getByLabel('Signé par Mme Mariétou Sorgho').check();
	await page.getByLabel('Signé par Immo Démo').check();
	await page.getByTestId('etape-suivante').click();
	await expect(page.getByTestId('refus-retenues')).toContainText('justificatif manquant');
	await expect(page.getByTestId('a-restituer')).toHaveText(amount('95 000 FCFA'));
});

test('aucun débordement horizontal sur téléphone, écrans du lot 00 ter', async ({ page }) => {
	await openDemo(page);
	const paths = [
		'/biens/nouveau',
		'/biens/p10/u17',
		'/sorties',
		'/sorties/l14',
		'/proprietaire',
		'/proprietaire/biens/agency-horizon/hp1',
		'/proprietaire/revenus',
		'/proprietaire/plus',
		'/locataire',
		'/locataire/historique',
		'/locataire/caution',
		'/locataire/signalements',
		'/locataire/plus',
		'/admin',
		'/admin/abonnements',
		'/admin/fonctionnalites',
		'/admin/assistance',
		'/admin/journal',
		'/espaces'
	];
	for (const path of paths) {
		await page.goto(path);
		await expect(page.locator('h1').first()).toBeVisible();
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
		expect(overflow, path).toBeLessThanOrEqual(0);
	}
});

test('navigation des espaces personnels sur téléphone : 4 onglets chacun, sans menu d’agence', async ({ page }) => {
	await openDemo(page, '/proprietaire');
	const nav = page.getByRole('navigation', { name: 'Navigation principale' });
	for (const name of ['Patrimoine', 'Revenus', 'Relevés', 'Plus']) await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
	await expect(nav.getByRole('link')).toHaveCount(4);
	await page.goto('/locataire');
	for (const name of ['Logement', 'Reçus', 'Caution', 'Plus']) await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
	await expect(nav.getByRole('link')).toHaveCount(4);
	await expect(page.getByRole('link', { name: 'Encaisser un loyer' })).toHaveCount(0);
});
