/**
 * Lot 09 : écrans d'encaissement, contre la vraie API et le vrai service PowerSync, sur les trois appareils.
 * - Agent de terrain, hors ligne : encaisser en 3 gestes et moins de 20 s ; reçu provisoire avec QR code et lien ;
 *   le lien ouvert avant la synchronisation affiche « Reçu en cours d'enregistrement », puis le reçu.
 * - Direction (téléphone, tablette, ordinateur) : réglages des reçus (préfixe, premier numéro, ticket), saisie d'un
 *   Mobile Money, validation groupée, numéro définitif, impression, QR code vers /r (noindex, no-store), annulation
 *   par contre-écriture (« ANNULÉ »), sans débordement horizontal.
 * - Gestion : réglages en lecture, validation possible, jamais l'annulation.
 * - Deux appareils hors ligne, même référence Mobile Money : le second est refusé à la synchronisation et rangé
 *   dans « Modifications non acceptées » (point b).
 * - Bailleur particulier : encaisser au clavier sur ordinateur (nom puis Entrée), loyers reçus.
 */
import { expect, test, type APIRequestContext, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import { toIsoDate } from '@ziga/shared/dates';
import { formatFcfa } from '@ziga/shared/money';
import { newId } from '@ziga/shared/ids';
import { newReceiptToken, provisionalReceiptNumber } from '@ziga/shared/payments';
import { addMember, availableUnit, freshAgency, get, leaseViaApi, login, post, type Agency, type Person } from './agency';
import { accounts, API_URL, expectNoHorizontalOverflow, registerViaApi, signInWith, synced } from './support';

const phone = { viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true };
const tablet = { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true };
const desktop = { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false };
const devices: [string, BrowserContextOptions][] = [
	['Téléphone (360 × 800)', phone],
	['Tablette (820 × 1180)', tablet],
	['Ordinateur (1440 × 900)', desktop]
];
const today = toIsoDate();
const year = today.slice(0, 4);

/** Encaissement saisi par l'API, comme l'enverrait un autre appareil. */
function entry(leaseId: string, extra: Record<string, unknown> = {}) {
	const receiptId = newId();
	return {
		id: newId(),
		leaseId,
		purpose: 'rent',
		amount: 40000,
		method: 'cash',
		paidOn: today,
		receiptId,
		provisionalNumber: provisionalReceiptNumber(receiptId),
		verificationToken: newReceiptToken(),
		shareToken: newReceiptToken(),
		...extra
	};
}

async function context(browser: Browser, options: BrowserContextOptions) {
	return browser.newContext({ ...options, locale: 'fr-FR', timezoneId: 'Africa/Ouagadougou', baseURL: 'http://localhost:4173' });
}

async function open(browser: Browser, options: BrowserContextOptions, who: Person, target: string) {
	const ctx = await context(browser, options);
	const page = await ctx.newPage();
	await signInWith(page, who, target);
	await expect(page).toHaveURL(target);
	await synced(page, 20_000);
	return { ctx, page };
}

/** Adresse de vérification imprimée sous le QR code du reçu. */
async function verificationLink(page: Page): Promise<string> {
	const text = await page
		.getByTestId('recu')
		.getByText(/\/r\/[A-Za-z0-9_-]+/)
		.textContent();
	return /(https?:\/\/\S+\/r\/[A-Za-z0-9_-]+)/.exec(text ?? '')![1]!;
}

test.describe('Agent de terrain, hors ligne (téléphone)', () => {
	test('encaisser en 3 gestes et moins de 20 s ; reçu provisoire, QR code, lien « en cours d’enregistrement » puis disponible', async ({
		browser,
		request
	}) => {
		test.setTimeout(3 * 60_000);
		const agency = await freshAgency(request, `Agence terrain ${newId().slice(-6)}`);
		const agent = await addMember(request, agency, 'field_agent', 'Agent encaisseur');
		const { unitId } = await availableUnit(request, agency, { agentId: agent.userId });
		const { leaseId } = await leaseViaApi(request, agency, unitId);

		const { ctx, page } = await open(browser, phone, agent, '/app/encaisser');
		await expect(page.getByTestId('cible')).toHaveCount(1, { timeout: 20_000 });
		await expectNoHorizontalOverflow(page, 'Encaisser (agent, téléphone)');
		await ctx.setOffline(true);

		const started = Date.now();
		// Geste 1 : trouver le locataire.
		await page.getByTestId('recherche-locataire').fill('awa oued');
		await page.getByTestId('cible').first().click();
		await expect(page.getByTestId('locataire-choisi')).toHaveText('Awa Ouédraogo');
		// Geste 2 : le montant est pré-rempli avec le reste exigible ; espèces par défaut.
		await expect(page.getByTestId('montant')).toHaveValue(/^[1-9]\d*$/);
		const amount = Number(await page.getByTestId('montant').inputValue());
		await expect(page.getByTestId('moyen-mobile_money_manual')).toHaveCount(0);
		await expect(page.getByRole('radio', { name: /Espèces/ })).toBeChecked();
		// Geste 3 : valider.
		await page.getByTestId('valider-encaissement').click();
		await expect(page).toHaveURL(/\/app\/encaissements\/[0-9a-f-]{36}$/);
		await expect(page.getByTestId('recu')).toBeVisible();
		expect(Date.now() - started, 'encaissement hors ligne en moins de 20 s').toBeLessThan(20_000);

		await expect(page.getByTestId('titre-recu')).toHaveText('Reçu provisoire');
		await expect(page.getByTestId('numero-recu')).toHaveText(/^N° PROV-[0-9A-F]{6}$/);
		await expect(page.getByTestId('statut-encaissement')).toHaveText('En attente d’envoi');
		await expect(page.getByTestId('recu').getByRole('img', { name: 'Vérifiez ce reçu' })).toBeVisible();
		await expect(page.getByTestId('valider')).toHaveCount(0);
		await expect(page.getByTestId('annuler')).toHaveCount(0);
		await expectNoHorizontalOverflow(page, 'Reçu provisoire (agent, téléphone)');
		const link = (await page.getByTestId('lien-recu').textContent())!.trim();
		expect(link).toMatch(/^http:\/\/localhost:4173\/recu\/[A-Za-z0-9_-]{43}$/);
		const paymentId = page.url().split('/').at(-1)!;

		// Le locataire ouvre le lien avant la synchronisation : « en cours d'enregistrement », jamais une erreur.
		const tenant = await context(browser, phone);
		const shared = await tenant.newPage();
		await shared.goto(link);
		await expect(shared.getByTestId('recu-en-cours')).toBeVisible();
		await expect(shared.getByText('Reçu en cours d’enregistrement')).toBeVisible();
		await expectNoHorizontalOverflow(shared, 'Reçu partagé en cours (téléphone)');

		// Retour du réseau : l'encaissement monte, « à valider » ; le lien affiche le reçu.
		await ctx.setOffline(false);
		await synced(page, 20_000);
		await expect(page.getByTestId('statut-encaissement')).toHaveText('À valider', { timeout: 20_000 });
		const server = await get<{ payment: { status: string; amount: number; method: string } }>(
			request,
			agency.headers,
			`/payments/${paymentId}`
		);
		expect(server.payment).toMatchObject({ status: 'to_validate', amount, method: 'cash' });
		await shared.getByRole('button', { name: 'Réessayer' }).click();
		await expect(shared.getByTestId('recu-en-cours')).toHaveCount(0);
		await expect(shared.getByText(formatFcfa(amount)).first()).toBeVisible();

		// La liste de l'agent montre son encaissement « à valider ».
		await page.goto('/app/encaissements');
		await expect(page.getByTestId('encaissement')).toHaveCount(1);
		await expect(page.getByTestId('encaissement').first()).toHaveAttribute('data-statut', 'to_validate');
		await expect(page.getByTestId('valider-selection')).toHaveCount(0);
		await expectNoHorizontalOverflow(page, 'Encaissements (agent, téléphone)');
		await tenant.close();
		await ctx.close();
		expect(leaseId).toBeTruthy();
	});
});

for (const [label, options] of devices) {
	test.describe(`Direction : ${label}`, () => {
		test('réglages, Mobile Money, validation groupée, numéro, impression, QR code, annulation', async ({ browser, request }) => {
			test.setTimeout(4 * 60_000);
			const agency = await freshAgency(request, `Agence direction ${newId().slice(-6)}`);
			const agent = await addMember(request, agency, 'field_agent', 'Agent de la direction');
			const { unitId } = await availableUnit(request, agency, { agentId: agent.userId });
			const { leaseId } = await leaseViaApi(request, agency, unitId);
			// Espèces saisies par l'agent sur son appareil : « à valider ».
			const cash = entry(leaseId);
			await post(request, agent.headers, '/payments', { payments: [cash] });

			const { ctx, page } = await open(browser, options, agency.director, '/app/organisation');

			// Réglages des reçus : préfixe, premier numéro (carnet papier), ticket 58 mm.
			const settings = page.getByTestId('reglages-recus');
			await expect(settings.getByTestId('prefixe-recus')).toBeEnabled();
			await settings.getByTestId('prefixe-recus').fill('agx');
			await settings.getByTestId('premier-numero').fill('124');
			await expect(settings.getByTestId('exemple-numero')).toHaveText(`Exemple : AGX-${year}-000124`);
			await settings.getByText('58 mm').click();
			await settings.getByRole('button', { name: 'Enregistrer' }).click();
			await expect(settings.getByText('Réglages des reçus enregistrés.')).toBeVisible();
			await expectNoHorizontalOverflow(page, `Réglages des reçus (${label})`);

			// Mobile Money saisi par la direction : « à rapprocher ».
			await page.goto('/app/encaisser');
			await synced(page, 20_000);
			await page.getByTestId('recherche-locataire').fill('Awa');
			await page.getByTestId('cible').first().click();
			await expect(page.getByTestId('montant')).toHaveValue(/^[1-9]\d*$/);
			await page.getByTestId('moyen-mobile_money_manual').click();
			await page.getByText('Orange Money', { exact: true }).click();
			await page.getByTestId('reference').fill('pp240917.1234.a56789');
			await expectNoHorizontalOverflow(page, `Encaisser (direction, ${label})`);
			await page.getByTestId('valider-encaissement').click();
			await expect(page).toHaveURL(/\/app\/encaissements\/[0-9a-f-]{36}$/);
			const mobileId = page.url().split('/').at(-1)!;
			await expect(page.getByTestId('statut-encaissement')).toHaveText('À rapprocher', { timeout: 20_000 });

			// Validation groupée : les espèces de l'agent et le Mobile Money.
			await page.goto('/app/a-valider');
			await synced(page, 20_000);
			await expect(page.getByTestId('encaissement')).toHaveCount(2);
			await expectNoHorizontalOverflow(page, `À valider (${label})`);
			await page.getByTestId('tout-selectionner').check();
			await expect(page.getByTestId('valider-selection')).toHaveText(/Valider la sélection \(2\)/);
			await page.getByTestId('valider-selection').click();
			await expect(page.getByText('2 encaissements confirmés.')).toBeVisible();
			await expect(page.getByTestId('encaissement')).toHaveCount(0, { timeout: 20_000 });

			// Liste : filtres, deux confirmés.
			await page.goto('/app/encaissements');
			await page.getByRole('button', { name: 'Confirmés' }).click();
			await expect(page.getByTestId('encaissement')).toHaveCount(2);
			await expectNoHorizontalOverflow(page, `Encaissements (${label})`);

			// Le reçu de la direction : numéro définitif au préfixe choisi, QR code (jeton créé sur cet appareil).
			await page.goto(`/app/encaissements/${mobileId}`);
			await expect(page.getByTestId('statut-encaissement')).toHaveText('Confirmé', { timeout: 20_000 });
			await expect(page.getByTestId('titre-recu')).toHaveText('Reçu de paiement');
			await expect(page.getByTestId('numero-recu')).toHaveText(new RegExp(`^N° AGX-${year}-00012[45]$`));
			const number = (await page.getByTestId('numero-recu').textContent())!.replace('N° ', '');
			await expect(page.getByTestId('recu')).toContainText('référence pp240917.1234.a56789');
			await expectNoHorizontalOverflow(page, `Reçu (${label})`);

			// Impression : seul le reçu sort sur le papier.
			await page.evaluate(() => {
				(window as unknown as { printed: number }).printed = 0;
				window.print = () => void ((window as unknown as { printed: number }).printed += 1);
			});
			await page.getByTestId('imprimer').click();
			expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1);
			await page.emulateMedia({ media: 'print' });
			await expect(page.getByTestId('recu')).toBeVisible();
			await expect(page.getByTestId('imprimer')).toBeHidden();
			await page.emulateMedia({ media: 'screen' });

			// QR code → /r : reçu valide, jamais indexé ni mis en cache.
			const verify = await verificationLink(page);
			const visitor = await (await context(browser, options)).newPage();
			const response = await visitor.goto(verify);
			expect(response!.headers()['x-robots-tag']).toContain('noindex');
			expect(response!.headers()['cache-control']).toContain('no-store');
			await expect(visitor.getByTestId('statut-verification')).toHaveText(/Reçu valide/);
			await expect(visitor.getByTestId('numero-verifie')).toHaveText(number);
			await expectNoHorizontalOverflow(visitor, `Vérification (${label})`);

			// Le préfixe est figé dès le premier reçu.
			// Annulation par contre-écriture : motif obligatoire, « ANNULÉ » sur le reçu et à la vérification.
			await page.getByTestId('annuler').click();
			await page.getByTestId('motif-annulation').fill('Erreur de saisie du montant');
			await page.getByTestId('confirmer-annulation').click();
			await expect(page.getByText('Encaissement annulé.')).toBeVisible();
			await expect(page.getByTestId('statut-encaissement')).toHaveText('Annulé', { timeout: 20_000 });
			await expect(page.getByTestId('recu')).toHaveAttribute('data-cancelled', '1', { timeout: 20_000 });
			await expect(page.getByTestId('mention-annule')).toBeVisible();
			await expect(page.getByTestId('numero-recu')).toHaveText(`N° ${number}`);
			await visitor.reload();
			await expect(visitor.getByTestId('statut-verification')).toHaveText(/Reçu annulé/);

			await page.goto('/app/organisation');
			await expect(page.getByTestId('prefixe-recus')).toBeDisabled();
			await expect(page.getByTestId('premier-numero')).toBeDisabled();
			await visitor.context().close();
			await ctx.close();
		});
	});
}

test.describe('Gestion (tablette)', () => {
	test.use(tablet);

	test('valide un encaissement, ne l’annule jamais ; la liste « À valider » se vide', async ({ browser, request }) => {
		test.setTimeout(3 * 60_000);
		const agency = await freshAgency(request, `Agence gestion ${newId().slice(-6)}`);
		const manager = await addMember(request, agency, 'manager', 'Gestionnaire validatrice');
		const agent = await addMember(request, agency, 'field_agent', 'Agent de la gestion');
		const { unitId } = await availableUnit(request, agency, { agentId: agent.userId });
		const { leaseId } = await leaseViaApi(request, agency, unitId);
		const cash = entry(leaseId);
		await post(request, agent.headers, '/payments', { payments: [cash] });

		const { ctx, page } = await open(browser, tablet, manager, `/app/encaissements/${cash.id}`);
		await expect(page.getByTestId('statut-encaissement')).toHaveText('À valider', { timeout: 20_000 });
		// Saisi sur un autre appareil : reçu provisoire, sans QR code (le jeton n'existe que sur l'appareil d'origine).
		await expect(page.getByTestId('titre-recu')).toHaveText('Reçu provisoire');
		await expect(page.getByTestId('annuler')).toHaveCount(0);
		await page.getByTestId('valider').click();
		await expect(page.getByText('Encaissement confirmé : le reçu est numéroté.')).toBeVisible();
		await expect(page.getByTestId('statut-encaissement')).toHaveText('Confirmé', { timeout: 20_000 });
		await expect(page.getByTestId('numero-recu')).toHaveText(new RegExp(`^N° [A-Z]{2,6}-${year}-000001$`));
		await expect(page.getByTestId('annuler')).toHaveCount(0);
		await expectNoHorizontalOverflow(page, 'Reçu (gestion, tablette)');
		await page.goto('/app/a-valider');
		await expect(page.getByText('Rien à valider')).toBeVisible();
		await ctx.close();
	});
});

test.describe('Deux appareils hors ligne, même référence Mobile Money (point b)', () => {
	test('le second est refusé à la synchronisation et apparaît dans « Modifications non acceptées »', async ({ browser, request }) => {
		test.setTimeout(4 * 60_000);
		const agency = await freshAgency(request, `Agence doublon ${newId().slice(-6)}`);
		const manager = await addMember(request, agency, 'manager', 'Gestionnaire du doublon');
		const { unitId } = await availableUnit(request, agency);
		const { leaseId } = await leaseViaApi(request, agency, unitId);
		const one = await open(browser, phone, agency.director, '/app/encaisser');
		const two = await open(browser, phone, manager, '/app/encaisser');
		await one.ctx.setOffline(true);
		await two.ctx.setOffline(true);

		async function mobileMoney(page: Page, reference: string) {
			await page.getByTestId('recherche-locataire').fill('Awa');
			await page.getByTestId('cible').first().click();
			await page.getByTestId('moyen-mobile_money_manual').click();
			await page.getByText('Orange Money', { exact: true }).click();
			await page.getByTestId('reference').fill(reference);
			await page.getByTestId('valider-encaissement').click();
			await expect(page).toHaveURL(/\/app\/encaissements\/[0-9a-f-]{36}$/);
			return page.url().split('/').at(-1)!;
		}
		// La même transaction, écrite différemment sur chaque appareil.
		const first = await mobileMoney(one.page, 'CI240917.1530.B11111');
		const second = await mobileMoney(two.page, 'ci 240917 1530 b11111');

		await one.ctx.setOffline(false);
		await synced(one.page, 20_000);
		await expect(one.page.getByTestId('statut-encaissement')).toHaveText('À rapprocher', { timeout: 20_000 });

		await two.ctx.setOffline(false);
		const notice = two.page.getByTestId('refus-notification');
		await expect(notice).toBeVisible({ timeout: 20_000 });
		await notice.getByRole('link', { name: 'Voir les modifications non acceptées' }).click();
		await expect(two.page).toHaveURL('/app/modifications-non-acceptees');
		const refused = two.page.getByTestId('refus').filter({ hasText: 'Encaissement' });
		await expect(refused).toHaveCount(1);
		await expect(refused).toHaveAttribute('data-code', 'MOBILE_MONEY_REFERENCE_DUPLICATE');
		await expectNoHorizontalOverflow(two.page, 'Modifications non acceptées (doublon)');

		const list = await get<{ items: { id: string }[] }>(request, agency.headers, `/payments?leaseId=${leaseId}`);
		expect(list.items.map((p) => p.id)).toEqual([first]);
		expect(list.items.map((p) => p.id)).not.toContain(second);
		await one.ctx.close();
		await two.ctx.close();
	});
});

/** Organisation de bailleur particulier (formule Pro), avec un bien à lui, une unité et un bail. */
async function landlordWithLease(request: APIRequestContext) {
	const who = await registerViaApi(request, 'Bailleur encaisseur');
	const token = await login(request, who.phone, who.password);
	const id = newId();
	const created = await request.post(`${API_URL}/organizations`, {
		headers: { Authorization: `Bearer ${token}` },
		data: { id, type: 'landlord', legalName: 'Bailleur encaisseur', phone: who.phone, commune: 'Ouagadougou' }
	});
	expect(created.status()).toBe(201);
	const admin = await login(request, accounts.admin.phone, accounts.admin.password);
	expect(
		(
			await request.put(`${API_URL}/admin/organizations/${id}/plan`, {
				headers: { Authorization: `Bearer ${admin}` },
				data: { planId: 'pro', reason: 'Test de bout en bout : encaissements' }
			})
		).status()
	).toBe(204);
	const agency: Agency = { id, director: who, headers: { Authorization: `Bearer ${token}`, 'X-Organization-Id': id } };
	// Sa propre fiche propriétaire, créée avec l'organisation ; ses biens sont couverts par son mandat self_managed.
	const owners = await get<{ id: string }[]>(request, agency.headers, '/owners');
	const geo = (await (await request.get(`${API_URL}/admin/geography`, { headers: { Authorization: `Bearer ${admin}` } })).json()) as {
		neighborhoods: { id: string; name: string }[];
	};
	const propertyId = newId();
	await post(request, agency.headers, '/properties', {
		id: propertyId,
		ownerId: owners[0]!.id,
		type: 'apartment_building',
		name: 'Cour familiale',
		communeId: 'ouagadougou',
		neighborhoodId: geo.neighborhoods.find((n) => n.name === 'Tampouy')!.id
	});
	await post(request, agency.headers, `/properties/${propertyId}/status`, { status: 'active' });
	const unitId = newId();
	await post(request, agency.headers, '/units', {
		id: unitId,
		propertyId,
		type: 'apartment',
		label: 'Studio 1',
		rent: 75000,
		charges: 5000,
		depositAmount: 150000,
		advanceMonths: 1
	});
	await post(request, agency.headers, `/units/${unitId}/status`, { status: 'active' });
	const { leaseId } = await leaseViaApi(request, agency, unitId, 'organization');
	return { agency, leaseId };
}

test.describe('Bailleur particulier', () => {
	for (const [label, options] of [devices[0]!, devices[2]!]) {
		test(`encaisse un loyer (${label}) ; ses loyers reçus`, async ({ browser, request }) => {
			test.setTimeout(3 * 60_000);
			const { agency } = await landlordWithLease(request);
			const { ctx, page } = await open(browser, options, agency.director, '/app/encaisser');
			await expect(page.getByTestId('cible')).toHaveCount(1, { timeout: 20_000 });
			if (options === desktop) {
				// Sur ordinateur : on tape un nom puis Entrée ; liste et formulaire côte à côte.
				await page.getByTestId('recherche-locataire').fill('Ouédraogo');
				await page.getByTestId('recherche-locataire').press('Enter');
				await expect(page.getByTestId('recherche-locataire')).toBeVisible();
			} else {
				await page.getByTestId('recherche-locataire').fill('Ouédraogo');
				await page.getByTestId('cible').first().click();
			}
			await expect(page.getByTestId('montant')).toHaveValue(/^[1-9]\d*$/);
			await page.getByTestId('moyen-cash').click();
			await expectNoHorizontalOverflow(page, `Encaisser (bailleur, ${label})`);
			await page.getByTestId('valider-encaissement').click();
			await expect(page.getByTestId('statut-encaissement')).toHaveText('Confirmé', { timeout: 20_000 });
			await expect(page.getByTestId('titre-recu')).toHaveText('Reçu de paiement');
			const nav = page.getByRole('navigation', { name: 'Navigation principale' });
			await nav
				.getByRole('link', { name: /Loyers reçus|Loyers/ })
				.first()
				.click();
			await expect(page).toHaveURL('/app/encaissements');
			await expect(page.getByTestId('encaissement')).toHaveCount(1);
			await expect(page.getByTestId('encaissement').first()).toHaveAttribute('data-statut', 'confirmed');
			await expectNoHorizontalOverflow(page, `Loyers reçus (bailleur, ${label})`);
			await ctx.close();
		});
	}
});
