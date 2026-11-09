/**
 * Organisations, équipe, paramètres et journal (lot 03), contre la vraie API et son worker.
 * Critère d'acceptation : un directeur invite un gestionnaire, qui accepte depuis un autre téléphone, en moins de 2 minutes.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import {
	accounts,
	API_URL,
	apiIdle,
	expectNoHorizontalOverflow,
	openOrganization,
	ORG_A,
	registerViaApi,
	signIn,
	signInWith,
	synced
} from './support';

const phone = { viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true };
const tablet = { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true };
const desktop = { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false };

/** Logo de test : PNG de 120 × 60 px. */
const LOGO_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAHgAAAA8CAIAAAAiz+n/AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAa0lEQVR42u3QMQ0AAAgDsDnBD2bw/+GCcDSpgqamORAFokUjWrRoC6JFI1q0aAuiRSNatGhEi0a0aNGIFo1o0aIRLRrRokUjWjSiRYtGtGhEixaNaNGIFi0a0aIRLVo0okUjWrRoRItG9C8Law28WiWZHZAAAAAASUVORK5CYII=',
	'base64'
);

const mainNav = (page: Page) => page.getByRole('navigation', { name: 'Navigation principale' });

async function phonePage(browser: Browser) {
	const context = await browser.newContext({ ...phone, baseURL: 'http://localhost:4173', locale: 'fr-FR' });
	return { context, page: await context.newPage() };
}

test.describe('Invitation d’un collaborateur', () => {
	test.use(desktop);

	test('le directeur invite un gestionnaire, qui accepte depuis un autre téléphone, en moins de 2 minutes', async ({
		page,
		browser,
		request
	}) => {
		const started = Date.now();
		const newcomer = await registerViaApi(request, 'Rasmané Ouédraogo');

		await signIn(page, 'director', '/app/equipe');
		await page.getByRole('button', { name: 'Inviter un collaborateur' }).click();
		await page.getByLabel('Numéro de téléphone').fill(newcomer.national);
		await page.getByLabel('Rôle').selectOption('manager');
		await page.getByRole('button', { name: 'Créer l’invitation' }).click();
		const link = (await page.getByTestId('lien').innerText()).trim();
		expect(link).toMatch(/^http:\/\/localhost:4173\/invitation\/[0-9a-f-]{36}\.[A-Za-z0-9_-]{40,}$/);
		// Bouton WhatsApp : numéro de l'invité et lien dans le message.
		const wa = await page.getByTestId('whatsapp').getAttribute('href');
		expect(wa).toContain(`wa.me/226${newcomer.national}`);
		expect(decodeURIComponent(wa!)).toContain(link);
		await page.keyboard.press('Escape');
		// D'autres tests invitent en parallèle dans la même agence : on cherche cette invitation, par son numéro.
		await expect(page.getByTestId('invitation').filter({ hasText: new RegExp(newcomer.national.match(/../g)!.join('\\s')) })).toBeVisible();

		// Second téléphone : la personne ouvre le lien, se connecte, accepte.
		const other = await phonePage(browser);
		await other.page.goto(link.replace('http://localhost:4173', ''));
		await expect(other.page.getByTestId('invitation')).toContainText(ORG_A);
		await expect(other.page.getByTestId('invitation')).toContainText('Rôle proposé : Gestionnaire');
		await other.page.getByRole('link', { name: 'Se connecter' }).click();
		await expect(other.page).toHaveURL(/\/connexion\?retour=%2Finvitation%2F/);
		await signInWith(other.page, newcomer, new URL(link).pathname);
		await expect(other.page).toHaveURL(new URL(link).pathname);
		await other.page.getByRole('button', { name: 'Accepter l’invitation' }).click();
		await expect(other.page).toHaveURL('/app');
		await expect(mainNav(other.page).getByRole('link')).toHaveText(['Accueil', 'Biens', 'Encaissements', 'Plus']);
		expect(Date.now() - started).toBeLessThan(120_000);

		// Le directeur voit le nouveau membre ; le journal garde l'invitation et l'acceptation.
		await page.reload();
		await expect(page.getByTestId('membre').filter({ hasText: 'Rasmané Ouédraogo' })).toContainText('Gestionnaire');
		await page.goto('/app/journal');
		await expect(page.getByTestId('evenement').filter({ hasText: 'Invitation acceptée' }).first()).toBeVisible();

		// Retrait : la personne perd l'accès à sa prochaine requête et revient au choix de l'espace.
		await page.goto('/app/equipe');
		await page.getByRole('button', { name: 'Actions : Rasmané Ouédraogo' }).click();
		await page.getByRole('menuitem', { name: 'Retirer de l’équipe' }).click();
		await page.getByRole('button', { name: 'Retirer', exact: true }).click();
		await expect(page.getByTestId('membre').filter({ hasText: 'Rasmané Ouédraogo' })).toHaveCount(0);
		await other.page.goto('/app/equipe');
		await expect(other.page).toHaveURL('/espace');
		await expect(other.page.getByRole('alert')).toHaveText('Vous n’êtes plus membre de cette organisation.');
		await other.context.close();
	});

	test('un lien ouvert avec un autre numéro est refusé', async ({ page, browser, request }) => {
		const invited = await registerViaApi(request, 'Personne invitée');
		await signIn(page, 'director', '/app/equipe');
		await page.getByRole('button', { name: 'Inviter un collaborateur' }).click();
		await page.getByLabel('Numéro de téléphone').fill(invited.national);
		await page.getByRole('button', { name: 'Créer l’invitation' }).click();
		const link = new URL((await page.getByTestId('lien').innerText()).trim()).pathname;
		const other = await phonePage(browser);
		await signInWith(other.page, accounts.person, link);
		await other.page.getByRole('button', { name: 'Accepter l’invitation' }).click();
		await expect(other.page.getByTestId('erreur-formulaire')).toContainText('Cette invitation est destinée au');
		await other.context.close();
	});

	test('le gestionnaire voit l’équipe en lecture, sans pouvoir inviter', async ({ page }) => {
		await signIn(page, 'managerB', '/app/equipe');
		await expect(page.getByTestId('membre')).toHaveCount(4);
		await expect(page.getByRole('button', { name: 'Inviter un collaborateur' })).toHaveCount(0);
		await expect(page.getByRole('button', { name: /^Actions/ })).toHaveCount(0);
		await expect(page.getByRole('status')).toContainText('Vous voyez l’équipe en lecture.');
	});
});

test.describe('Création d’une organisation', () => {
	test.use(phone);

	test('« Je suis une agence » : la personne en devient directrice, l’espace de gestion s’ouvre', async ({ page, request }) => {
		const who = await registerViaApi(request, 'Alima Sanou');
		await signInWith(page, who);
		await expect(page.getByTestId('espaces-gestion')).toContainText('Vous n’êtes membre d’aucune organisation.');
		await page.getByTestId('creer-organisation').click();
		await page.getByTestId('type-agence').click();
		await page.getByLabel('Raison sociale').fill('Sanou Immobilier');
		await page.getByLabel('Téléphone de contact').fill('25 30 40 50');
		await page.getByLabel('Commune').fill('Ouagadougou');
		await page.getByRole('button', { name: 'Créer', exact: true }).click();
		await expect(page).toHaveURL('/app');
		await mainNav(page).getByRole('link', { name: 'Plus' }).tap();
		await expect(page.getByTestId('ecran-plus').getByRole('link', { name: 'Équipe' })).toBeVisible();
		await page.goto('/espace');
		await expect(page.getByTestId('espace-organisation')).toContainText('Mon agence : Sanou Immobilier');
		await expect(page.getByTestId('espace-organisation')).toContainText('En attente de vérification');
	});

	test('« Je gère mes propres logements » : navigation du bailleur, sans équipe', async ({ page, request }) => {
		const who = await registerViaApi(request, 'Hamidou Bationo');
		await signInWith(page, who, '/espace/nouvelle-organisation');
		await page.getByTestId('type-bailleur').click();
		await expect(page.getByLabel('Votre nom (bailleur)')).toHaveValue('Hamidou Bationo');
		await page.getByLabel('Téléphone de contact').fill(who.national);
		await page.getByLabel('Commune').fill('Saaba');
		await page.getByRole('button', { name: 'Créer', exact: true }).click();
		await expect(page).toHaveURL('/app');
		await expect(mainNav(page).getByRole('link')).toHaveText(['Accueil', 'Logements', 'Loyers', 'Plus']);
		// Le bailleur gère seul ses logements : pas d'équipe dans le menu, ni d'invitation possible.
		await page.goto('/app/equipe');
		await expect(page.getByRole('status')).toContainText('Un bailleur particulier gère seul ses logements');
		await expect(page.getByRole('button', { name: 'Inviter un collaborateur' })).toHaveCount(0);
	});
});

test.describe('Organisation active', () => {
	test.use(desktop);

	test('une personne de deux organisations n’en voit qu’une à la fois', async ({ page }) => {
		await signIn(page, 'managerAndLandlord', '/espace');
		await openOrganization(page, 'Mes logements');
		await expect(page.getByTestId('organisation-active')).toContainText('Mariam Zongo');
		await expect(mainNav(page).getByRole('link', { name: 'Équipe' })).toHaveCount(0);
		await openOrganization(page, ORG_A);
		await expect(page.getByTestId('organisation-active')).toContainText(ORG_A);
		await expect(mainNav(page).getByRole('link', { name: 'Équipe' })).toHaveCount(1);
		await page.goto('/app/equipe');
		await expect(page.getByTestId('membre')).toHaveCount(4);
		await expect(page.getByTestId('membre').filter({ hasText: 'Mariam Zongo' })).toContainText('Gestionnaire');
	});
});

test.describe('Paramètres de l’organisation', () => {
	test.use(desktop);

	test('le directeur complète la fiche et le représentant légal, envoie un logo ; l’aperçu des reçus suit', async ({ page, request }) => {
		const who = await registerViaApi(request, 'Clarisse Yaméogo');
		await signInWith(page, who, '/espace/nouvelle-organisation');
		await page.getByTestId('type-agence').click();
		await page.getByLabel('Raison sociale').fill('Yaméogo Gestion SARL');
		await page.getByLabel('Téléphone de contact').fill('25 31 32 33');
		await page.getByLabel('Commune').fill('Ouagadougou');
		await page.getByRole('button', { name: 'Créer', exact: true }).click();
		await expect(page).toHaveURL('/app');

		await page.goto('/app/organisation');
		// Identifiant de requête de chaque envoi de la synchronisation (en-tête x-request-id).
		const uploads: string[] = [];
		page.on('response', (r) => {
			if (r.url() === `${API_URL}/sync/upload` && r.request().method() === 'POST') uploads.push(r.headers()['x-request-id'] ?? '');
		});
		await page.getByLabel('Nom commercial').fill('Yaméogo Gestion');
		await page.getByLabel('Boîte postale').fill('01 BP 4321 Ouagadougou 01');
		await page.getByLabel('RCCM').fill('bf oua 2021 b 777');
		await page.getByLabel('IFU').fill('00098765b');
		await page.getByLabel('Nom et prénoms').fill('Clarisse Yaméogo');
		await page.getByLabel('Qualité').fill('Gérante');
		await page.getByLabel('Pièce d’identité').selectOption('other');
		await page.getByRole('button', { name: 'Enregistrer' }).click();
		await expect(page.getByText('Précisez le type de pièce.')).toBeVisible();
		await page.getByLabel('Précisez la pièce').fill('Carte d’électeur');
		await page.getByRole('button', { name: 'Enregistrer' }).click();
		await expect(page.getByText('Paramètres enregistrés.')).toBeVisible();
		const preview = page.getByTestId('apercu-entete');
		await expect(preview).toContainText('Yaméogo Gestion');
		await expect(preview).toContainText('RCCM BF OUA 2021 B 777 · IFU 00098765B');

		await page.getByTestId('logo-fichier').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: LOGO_PNG });
		await expect(preview.locator('img')).toHaveAttribute('src', /\/logos\/[0-9a-f-]+\/[0-9a-f-]+\/web\.webp$/, { timeout: 15_000 });
		await expect(page.getByTestId('logo-message')).toHaveText('Logo en place.');

		// Chaque modification est au journal, avec avant et après (une fois envoyée par la synchronisation, lot 05).
		await synced(page);
		await page.goto('/app/journal');
		// Lot 05 : la fiche et le représentant légal partent en deux opérations, donc deux lignes, chacune exacte.
		const updates = page.getByTestId('evenement').filter({ hasText: 'Paramètres modifiés' });
		await expect(updates.filter({ hasText: 'RCCM' })).toContainText('BF OUA 2021 B 777');
		await expect(updates.filter({ hasText: 'Représentant légal' })).toContainText('Clarisse Yaméogo, Gérante');
		await expect(page.getByTestId('evenement').filter({ hasText: 'Nouveau logo en place' })).toHaveCount(1);
		// Les deux lignes viennent d'un même enregistrement : elles portent le même request_id, celui de l'envoi.
		const login = await request.post(`${API_URL}/auth/login`, { data: { phone: who.phone, password: who.password } });
		const headers = { Authorization: `Bearer ${((await login.json()) as { accessToken: string }).accessToken}` };
		const [mine] = (await (await request.get(`${API_URL}/me/organizations`, { headers })).json()) as { organizationId: string }[];
		const journal = (await (
			await request.get(`${API_URL}/organization/audit`, { headers: { ...headers, 'X-Organization-Id': mine!.organizationId } })
		).json()) as { entries: { action: string; origin: string; requestId: string | null }[] };
		const saved = journal.entries.filter((e) => e.action === 'organization.update');
		expect(saved).toHaveLength(2);
		expect(saved.map((e) => e.origin)).toEqual(['sync', 'sync']);
		expect(saved[0]!.requestId).toBeTruthy();
		expect(saved[1]!.requestId).toBe(saved[0]!.requestId);
		expect(uploads).toContain(saved[0]!.requestId);
	});

	test('les autres rôles n’ont pas les paramètres dans le menu', async ({ page }) => {
		await signIn(page, 'managerB', '/app');
		await expect(mainNav(page).getByRole('link', { name: 'Paramètres de l’organisation' })).toHaveCount(0);
		await expect(mainNav(page).getByRole('link', { name: 'Journal' })).toHaveCount(0);
	});
});

test.describe('Mon compte', () => {
	test.use(phone);

	test('modifier son nom et changer son mot de passe ; l’activité du compte le montre', async ({ page, request }) => {
		const who = await registerViaApi(request, 'Ousmane Ouattara');
		await signInWith(page, who, '/espace/compte');
		await page.getByLabel('Nom complet').fill('Ousmane B. Ouattara');
		await page.getByRole('button', { name: 'Enregistrer le nom' }).click();
		await expect(page.getByText('Nom enregistré.')).toBeVisible();
		await page.getByLabel('Mot de passe actuel').fill(who.password);
		await page.getByLabel('Nouveau mot de passe', { exact: true }).fill('encore-plus-solide');
		await page.getByRole('button', { name: 'Changer le mot de passe' }).click();
		await expect(page.getByText('Mot de passe changé.')).toBeVisible();
		await page.getByRole('link', { name: 'Mes appareils' }).click();
		const journal = page.getByTestId('journal');
		await expect(journal.getByTestId('evenement').first()).toContainText('Mot de passe changé');
		await expect(journal).toContainText('Nom modifié');
		await expect(journal).toContainText('Compte créé');
	});
});

for (const [name, device] of [
	['téléphone', phone],
	['tablette', tablet],
	['ordinateur', desktop]
] as const) {
	test.describe(`Écrans du lot 03 (${name})`, () => {
		test.use(device);

		test('aucun débordement horizontal, cibles de 44 px', async ({ page }) => {
			await signIn(page, 'director', '/app');
			for (const path of [
				'/app/equipe',
				'/app/organisation',
				'/app/journal',
				'/espace',
				'/espace/compte',
				'/espace/nouvelle-organisation'
			]) {
				await page.goto(path);
				await expect(page.locator('h1').first()).toBeVisible();
				if (path.startsWith('/app')) await synced(page);
				await apiIdle(page);
				await expectNoHorizontalOverflow(page, path);
				for (const h of await page
					.locator('main button:visible, main input:visible:not([type=file]), main select:visible')
					.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) {
					expect(h, path).toBeGreaterThanOrEqual(44);
				}
			}
		});
	});
}
