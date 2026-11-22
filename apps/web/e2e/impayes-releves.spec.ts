/**
 * Lot 10 : écrans des impayés, relances, dépenses et relevés, contre la vraie API et le vrai service PowerSync, sur les
 * trois appareils.
 * - Accueil par profil et par appareil, impayés, dépenses et relevés sans débordement horizontal.
 * - Gestion, ordinateur, depuis l'accueil : 5 relances WhatsApp en série en moins de 2 minutes ; lien wa.me sans « + »,
 *   message encodé. Interrupteur `collections.reminders_whatsapp_link` coupé : bouton absent, visite toujours possible.
 * - Agent de terrain, hors ligne : « Ma tournée », visite notée sur l'appareil, envoyée au retour du réseau ; ni
 *   dépenses ni relevés.
 * - Dépense saisie hors ligne sur téléphone, annulée en ligne par la direction.
 * - Lot 10 bis, étape 0 : justificatif d'une dépense (photo ou PDF réunis en un PDF sur l'appareil), préparé hors ligne
 *   à la saisie et envoyé au retour du réseau, ou ajouté après coup ; consulté par URL signée ; une seule fois ; le
 *   profil lecture voit qu'il est joint sans pouvoir l'ouvrir. Trois appareils, sans débordement horizontal.
 * - Relevé préparé, émis, envoyé par WhatsApp au propriétaire, reversement enregistré ; page /s/<jeton> rendue sans
 *   JavaScript, noindex et no-store, sans aucun téléphone de locataire, en moins de 3 s en 3G (1,6 Mbit/s, 300 ms,
 *   cache vide) ; liens révoqués : page introuvable. Profil lecture : rien à préparer.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import { addDays, toIsoDate } from '@ziga/shared/dates';
import { newId } from '@ziga/shared/ids';
import { formatFcfa } from '@ziga/shared/money';
import { newReceiptToken, provisionalReceiptNumber } from '@ziga/shared/payments';
import { addMonthsToMonth, monthLabel, monthOfDate } from '@ziga/shared/statements';
import { PDFDocument } from 'pdf-lib';
import { addMember, freshAgency, get, login, post, type Agency, type Person } from './agency';
import { accounts, API_URL, expectNoHorizontalOverflow, signInWith, synced } from './support';

const phone = { viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true };
const tablet = { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true };
const desktop = { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false };
const devices: [string, BrowserContextOptions][] = [
	['Téléphone (360 × 800)', phone],
	['Tablette (820 × 1180)', tablet],
	['Ordinateur (1440 × 900)', desktop]
];
const today = toIsoDate();
const currentMonth = monthOfDate(today);
const previousMonth = addMonthsToMonth(currentMonth, -1);
const OWNER_PHONE = '+22670900003';
const tenantPhone = (i: number) => `+2267044${String(5500 + i).padStart(4, '0')}`;
const TENANTS = ['Awa Ouédraogo', 'Issa Kaboré', 'Fatimata Sawadogo', 'Boukary Compaoré', 'Rasmata Traoré'];

/**
 * Un propriétaire sous mandat (10 % de l'encaissé) depuis un an, un bien et `n` unités louées depuis le 1er d'il y a
 * deux mois : les échéances des deux mois passés sont en retard.
 */
async function portfolio(request: APIRequestContext, agency: Agency, n: number, opts: { agentId?: string; offset?: number } = {}) {
	const ownerId = newId();
	const mandateId = newId();
	await post(request, agency.headers, '/owners', { id: ownerId, type: 'person', name: 'Mariam Zongo', phone: OWNER_PHONE });
	await post(request, agency.headers, '/mandates', {
		id: mandateId,
		ownerId,
		type: 'rental_management',
		startsOn: addDays(today, -365),
		commission: { basis: 'percent_of_collected', rateBp: 1000 },
		canCollectFunds: true,
		canTakePhotos: true
	});
	const admin = await login(request, accounts.admin.phone, accounts.admin.password);
	const geo = (await (await request.get(`${API_URL}/admin/geography`, { headers: { Authorization: `Bearer ${admin}` } })).json()) as {
		neighborhoods: { id: string; name: string }[];
	};
	const propertyId = newId();
	await post(request, agency.headers, '/properties', {
		id: propertyId,
		ownerId,
		type: 'apartment_building',
		name: `Immeuble ${propertyId.slice(-4)}`,
		communeId: 'ouagadougou',
		neighborhoodId: geo.neighborhoods.find((x) => x.name === 'Tampouy')!.id
	});
	await post(request, agency.headers, `/properties/${propertyId}/status`, { status: 'active' });
	await post(request, agency.headers, `/mandates/${mandateId}/scopes`, { id: newId(), propertyId });
	const leases: { leaseId: string; tenantId: string; name: string; phone: string }[] = [];
	for (let k = 0; k < n; k++) {
		const i = k + (opts.offset ?? 0);
		const unitId = newId();
		await post(request, agency.headers, '/units', {
			id: unitId,
			propertyId,
			type: 'apartment',
			label: `A${i + 1}`,
			rent: 75000,
			charges: 5000
		});
		await post(request, agency.headers, `/units/${unitId}/status`, { status: 'active' });
		if (opts.agentId) await post(request, agency.headers, `/units/${unitId}/assign`, { agentId: opts.agentId });
		const tenantId = newId();
		await post(request, agency.headers, '/tenants', { id: tenantId, fullName: TENANTS[i]!, phone: tenantPhone(i) });
		const leaseId = newId();
		await post(request, agency.headers, '/leases', {
			id: leaseId,
			unitId,
			tenantId,
			startsOn: `${addMonthsToMonth(currentMonth, -2)}-01`,
			rent: 75000,
			charges: 5000,
			lessorType: 'owner'
		});
		leases.push({ leaseId, tenantId, name: TENANTS[i]!, phone: tenantPhone(i) });
	}
	return { ownerId, propertyId, leases };
}

/** Impayés calculés par l'API (la même fonction que l'appareil) : le total attendu de chaque locataire. */
async function arrears(request: APIRequestContext, agency: Agency) {
	const page = await get<{ items: { tenantId: string; total: number; remindable: number }[] }>(
		request,
		agency.headers,
		'/collections/arrears'
	);
	return new Map(page.items.map((g) => [g.tenantId, g]));
}

/** Loyer payé en espèces par la direction (confirmé), à une date donnée. */
async function pay(request: APIRequestContext, agency: Agency, leaseId: string, paidOn: string, amount = 80000) {
	const receiptId = newId();
	await post(request, agency.headers, '/payments', {
		payments: [
			{
				id: newId(),
				leaseId,
				purpose: 'rent',
				amount,
				method: 'cash',
				paidOn,
				receiptId,
				provisionalNumber: provisionalReceiptNumber(receiptId),
				verificationToken: newReceiptToken(),
				shareToken: newReceiptToken()
			}
		]
	});
}

async function context(browser: Browser, options: BrowserContextOptions) {
	const ctx = await browser.newContext({ ...options, locale: 'fr-FR', timezoneId: 'Africa/Ouagadougou', baseURL: 'http://localhost:4173' });
	// wa.me n'est pas ouvert : chaque adresse passée à window.open est gardée pour être vérifiée.
	await ctx.addInitScript(() => {
		const w = window as unknown as { __opened: string[] };
		w.__opened = [];
		window.open = ((url?: string | URL) => {
			w.__opened.push(String(url));
			return null;
		}) as typeof window.open;
	});
	return ctx;
}

async function open(browser: Browser, options: BrowserContextOptions, who: Person, target: string) {
	const ctx = await context(browser, options);
	const page = await ctx.newPage();
	await signInWith(page, who, target);
	await expect(page).toHaveURL(target);
	await synced(page, 20_000);
	return { ctx, page };
}

async function onePagePdf(): Promise<Buffer> {
	const doc = await PDFDocument.create();
	doc.addPage([595, 842]);
	return Buffer.from(await doc.save());
}

const PHOTO = readFileSync(join(import.meta.dirname, 'fixtures/photo.jpg'));

/** Ouvre l'adresse signée gardée par window.open et renvoie le début du fichier servi. */
async function openedFileHead(request: APIRequestContext, page: Page): Promise<string> {
	await expect.poll(async () => (await opened(page)).length, { timeout: 10_000 }).toBeGreaterThan(0);
	const url = (await opened(page)).at(-1)!;
	const r = await request.get(url);
	expect(r.status()).toBe(200);
	return (await r.body()).subarray(0, 5).toString('latin1');
}

const opened = (page: Page) => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);

test.describe('Accueil, impayés, dépenses et relevés sur les trois appareils', () => {
	for (const [label, options] of devices) {
		test(`direction, ${label} : indicateurs, listes et formulaires sans débordement`, async ({ browser, request }) => {
			test.setTimeout(3 * 60_000);
			const agency = await freshAgency(request, `Agence accueil ${newId().slice(-6)}`);
			const { leases } = await portfolio(request, agency, 2);
			const expected = [...(await arrears(request, agency)).values()].reduce((s, g) => s + g.total, 0);
			expect(expected).toBeGreaterThanOrEqual(4 * 80000);
			const { ctx, page } = await open(browser, options, agency.director, '/app');

			await expect(page.getByTestId('kpi-impayes')).toContainText(formatFcfa(expected), { timeout: 20_000 });
			await expect(page.getByTestId('kpi-loyers')).toBeVisible();
			await expect(page.getByTestId('kpi-taux')).toBeVisible();
			await expect(page.getByTestId('kpi-releves')).toHaveCount(options === tablet ? 0 : 1);
			await expect(page.getByTestId('plus-anciens-retards')).toHaveCount(options === desktop ? 1 : 0);
			await expect(page.getByTestId('echeances-du-jour')).toBeVisible();
			await expectNoHorizontalOverflow(page, `Accueil (direction, ${label})`);

			await page.goto('/app/impayes');
			await expect(page.getByTestId('impaye')).toHaveCount(2, { timeout: 20_000 });
			const awa = page.locator(`[data-testid="impaye"][data-locataire="${leases[0]!.name}"]`);
			await expect(awa).toHaveCount(1);
			await expect(page.getByTestId('relancer-selection')).toHaveCount(options === desktop ? 1 : 0);
			await expectNoHorizontalOverflow(page, `Impayés (direction, ${label})`);
			await awa.getByTestId('relancer').click();
			await expect(page.getByTestId('relance-message')).toContainText(`Bonjour ${leases[0]!.name}`);
			await expectNoHorizontalOverflow(page, `Relance (direction, ${label})`);
			await page.keyboard.press('Escape');

			await page.goto('/app/depenses');
			await page.getByTestId('nouvelle-depense').click();
			await expect(page.getByTestId('formulaire-depense')).toBeVisible();
			await expectNoHorizontalOverflow(page, `Nouvelle dépense (direction, ${label})`);
			await page.keyboard.press('Escape');

			await page.goto('/app/releves');
			await expect(page.getByRole('heading', { name: monthLabel(previousMonth), level: 2 })).toBeVisible();
			await expect(page.getByTestId('releve-proprietaire')).toHaveCount(1, { timeout: 20_000 });
			await expectNoHorizontalOverflow(page, `Relevés (direction, ${label})`);

			await page.goto('/app/organisation');
			await expect(page.getByTestId('modele-relance')).toHaveCount(3, { timeout: 20_000 });
			await expectNoHorizontalOverflow(page, `Modèles de relance (direction, ${label})`);
			await ctx.close();
		});
	}
});

test.describe('Relances WhatsApp', () => {
	test('gestion, ordinateur, depuis l’accueil : 5 relances en série en moins de 2 minutes ; liens wa.me encodés, sans « + »', async ({
		browser,
		request
	}) => {
		test.setTimeout(4 * 60_000);
		const agency = await freshAgency(request, `Agence relances ${newId().slice(-6)}`);
		const manager = await addMember(request, agency, 'manager', 'Gestionnaire des relances');
		const { leases } = await portfolio(request, agency, 5);
		const due = await arrears(request, agency);
		const { ctx, page } = await open(browser, desktop, manager, '/app');
		await expect(page.getByTestId('kpi-impayes')).toBeVisible();

		const started = Date.now();
		await page.getByTestId('kpi-impayes').click();
		await expect(page.getByTestId('impaye')).toHaveCount(5, { timeout: 20_000 });
		await page.getByTestId('tout-selectionner').check();
		await page.getByTestId('relancer-selection').click();
		for (let i = 1; i <= 5; i++) {
			await expect(page.getByTestId('progression')).toHaveText(`${i} sur 5`);
			await page.getByTestId('ouvrir-whatsapp').click();
			await page.getByTestId('confirmer-relance').click();
		}
		await expect(page.getByTestId('relance')).toHaveCount(0);
		await expect(page.getByText('5 relances enregistrées.')).toBeVisible();
		expect(Date.now() - started, '5 relances en moins de 2 minutes').toBeLessThan(120_000);

		const links = await opened(page);
		expect(links).toHaveLength(5);
		for (const link of links) {
			expect(link).toMatch(/^https:\/\/wa\.me\/22670\d{6}\?text=[^\s]+$/);
			expect(link).not.toContain('+');
			const url = new URL(link);
			const lease = leases.find((l) => url.pathname === `/${l.phone.slice(1)}`)!;
			expect(lease, link).toBeDefined();
			const text = url.searchParams.get('text')!;
			expect(text).toContain(`Bonjour ${lease.name},`);
			expect(text).toContain(formatFcfa(due.get(lease.tenantId)!.remindable));
			expect(link).toContain(encodeURIComponent(`Bonjour ${lease.name},`));
		}

		await synced(page, 20_000);
		await expect
			.poll(async () => (await get<{ channel: string }[]>(request, agency.headers, '/reminders?limit=50')).length, { timeout: 20_000 })
			.toBe(5);
		const server = await get<{ channel: string; templateLevel: number; tenantId: string }[]>(
			request,
			agency.headers,
			'/reminders?limit=50'
		);
		expect(new Set(server.map((r) => r.tenantId))).toEqual(new Set(leases.map((l) => l.tenantId)));
		expect(server.every((r) => r.channel === 'whatsapp_link' && r.templateLevel >= 1)).toBe(true);
		await ctx.close();
	});

	test('interrupteur coupé pour l’organisation : ni bouton Relancer ni modèles ; la visite reste possible', async ({
		browser,
		request
	}) => {
		test.setTimeout(3 * 60_000);
		const agency = await freshAgency(request, `Agence sans relance ${newId().slice(-6)}`);
		await portfolio(request, agency, 1);
		const off = await request.put(`${API_URL}/organization/features/collections.reminders_whatsapp_link`, {
			headers: agency.headers,
			data: { disabled: true }
		});
		expect(off.ok()).toBe(true);
		const { ctx, page } = await open(browser, phone, agency.director, '/app/impayes');
		await expect(page.getByTestId('impaye')).toHaveCount(1, { timeout: 20_000 });
		await expect(page.getByTestId('relancer')).toHaveCount(0);
		await expect(page.getByTestId('noter-visite')).toHaveCount(1);
		await page.goto('/app/organisation');
		await expect(page.getByTestId('reglages-recus')).toBeVisible({ timeout: 20_000 });
		await expect(page.getByTestId('modele-relance')).toHaveCount(0);
		await ctx.close();
	});

	test('agent de terrain, hors ligne : sa tournée, une visite notée puis envoyée ; ni dépenses ni relevés', async ({
		browser,
		request
	}) => {
		test.setTimeout(3 * 60_000);
		const agency = await freshAgency(request, `Agence tournée ${newId().slice(-6)}`);
		const agent = await addMember(request, agency, 'field_agent', 'Agent de la tournée');
		const { leases } = await portfolio(request, agency, 1, { agentId: agent.userId });
		await portfolio(request, agency, 1, { offset: 1 });
		const { ctx, page } = await open(browser, phone, agent, '/app');

		await expect(page.getByTestId('tournee').getByTestId('impaye')).toHaveCount(1, { timeout: 20_000 });
		await expect(page.getByTestId('impaye')).toHaveAttribute('data-locataire', leases[0]!.name);
		await expect(page.getByTestId('relancer')).toHaveCount(0);
		await expectNoHorizontalOverflow(page, 'Ma tournée (agent, téléphone)');

		await ctx.setOffline(true);
		await page.getByTestId('noter-visite').click();
		await page.locator('#note-relance').fill('Absent, promesse de paiement samedi');
		await page.getByTestId('enregistrer-visite').click();
		await expect(page.getByTestId('note-visite')).toHaveCount(0);
		await ctx.setOffline(false);
		await synced(page, 20_000);
		await expect
			.poll(async () => (await get<{ channel: string }[]>(request, agency.headers, '/reminders?limit=50')).map((r) => r.channel), {
				timeout: 20_000
			})
			.toEqual(['visit']);

		const nav = page.getByRole('navigation');
		await expect(nav.getByRole('link', { name: 'Dépenses' })).toHaveCount(0);
		await expect(nav.getByRole('link', { name: /Relevés/ })).toHaveCount(0);
		await page.goto('/app/releves');
		await expect(page.getByTestId('releve-proprietaire')).toHaveCount(0);
		await ctx.close();
	});
});

test.describe('Dépenses', () => {
	test('saisie hors ligne sur téléphone, envoyée au retour du réseau ; annulée en ligne par la direction', async ({ browser, request }) => {
		test.setTimeout(3 * 60_000);
		const agency = await freshAgency(request, `Agence dépenses ${newId().slice(-6)}`);
		await portfolio(request, agency, 1);
		const { ctx, page } = await open(browser, phone, agency.director, '/app/depenses');
		await ctx.setOffline(true);
		await page.getByTestId('nouvelle-depense').click();
		await page.getByTestId('depense-montant').fill('15000');
		await page.getByTestId('depense-description').fill('Fuite sous l’évier');
		await page.getByTestId('enregistrer-depense').click();
		await expect(page.getByTestId('formulaire-depense')).toHaveCount(0);
		await expect(page.getByTestId('depense')).toHaveCount(1);
		await expect(page.getByTestId('depense')).toContainText(formatFcfa(15000));
		await expect(page.getByTestId('depense')).toContainText('déduite de son relevé');
		await expectNoHorizontalOverflow(page, 'Dépenses (direction, téléphone)');
		await ctx.setOffline(false);
		await synced(page, 20_000);
		await expect
			.poll(async () => (await get<{ items: { amount: number }[] }>(request, agency.headers, '/expenses')).items.map((e) => e.amount), {
				timeout: 20_000
			})
			.toEqual([15000]);
		await ctx.close();

		const desk = await open(browser, desktop, agency.director, '/app/depenses');
		await expect(desk.page.getByTestId('depense')).toHaveCount(1, { timeout: 20_000 });
		await desk.page.getByRole('button', { name: 'Annuler la dépense' }).click();
		await desk.page.getByLabel('Motif de l’annulation').fill('Saisie en double');
		await desk.page.getByRole('button', { name: 'Annuler cette dépense' }).click();
		await expect(desk.page.getByTestId('depense')).toContainText('Annulée', { timeout: 20_000 });
		await expectNoHorizontalOverflow(desk.page, 'Dépenses (direction, ordinateur)');
		await desk.ctx.close();
	});
});

test.describe('Justificatif d’une dépense (lot 10 bis, étape 0)', () => {
	test('téléphone, hors ligne : photo du justificatif à la saisie, envoyée au retour du réseau, puis consultée', async ({
		browser,
		request
	}) => {
		test.setTimeout(3 * 60_000);
		const agency = await freshAgency(request, `Agence justificatif ${newId().slice(-6)}`);
		await portfolio(request, agency, 1);
		const { ctx, page } = await open(browser, phone, agency.director, '/app/depenses');
		await ctx.setOffline(true);
		await page.getByTestId('nouvelle-depense').click();
		await page.getByTestId('depense-montant').fill('12000');
		await page.getByTestId('depense-description').fill('Remplacement du robinet');
		await page.getByTestId('justificatif-photo').setInputFiles({ name: 'facture.jpg', mimeType: 'image/jpeg', buffer: PHOTO });
		await expect(page.getByTestId('justificatif-pieces')).toHaveText('1 pièce');
		await expectNoHorizontalOverflow(page, 'Nouvelle dépense avec justificatif (téléphone, hors ligne)');
		await page.getByTestId('enregistrer-depense').click();
		await expect(page.getByTestId('formulaire-depense')).toHaveCount(0);
		await expect(page.getByTestId('depense')).toHaveCount(1);
		await expect(page.getByTestId('justificatif-en-attente')).toBeVisible();
		await expectNoHorizontalOverflow(page, 'Dépense, justificatif en attente (téléphone)');
		await ctx.setOffline(false);
		await synced(page, 20_000);
		// La dépense part par la synchronisation, le justificatif par sa file : fiche, fichier, réception, rattachement.
		await expect
			.poll(
				async () =>
					(await get<{ items: { documentId: string | null }[] }>(request, agency.headers, '/expenses')).items[0]?.documentId ?? null,
				{
					timeout: 45_000
				}
			)
			.not.toBeNull();
		const [expense] = (await get<{ items: { id: string; documentId: string }[] }>(request, agency.headers, '/expenses')).items;
		const doc = await get<{ type: string; status: string; mimeType: string }>(request, agency.headers, `/documents/${expense!.documentId}`);
		expect(doc).toMatchObject({ type: 'expense_receipt', status: 'active', mimeType: 'application/pdf' });
		await page.getByTestId('voir-justificatif').click({ timeout: 20_000 });
		expect(await openedFileHead(request, page)).toBe('%PDF-');
		await ctx.close();
	});

	for (const [label, options] of devices) {
		test(`gestion, ${label} : justificatif ajouté après coup (PDF), une seule fois ; le profil lecture le voit joint`, async ({
			browser,
			request
		}) => {
			test.setTimeout(3 * 60_000);
			const agency = await freshAgency(request, `Agence justificatif ${newId().slice(-6)}`);
			const manager = await addMember(request, agency, 'manager', 'Gestionnaire des dépenses');
			const viewer = await addMember(request, agency, 'viewer', 'Lecture des dépenses');
			const { propertyId } = await portfolio(request, agency, 1);
			const id = newId();
			await post(request, agency.headers, '/expenses', {
				id,
				propertyId,
				spentOn: today,
				category: 'carpentry',
				description: 'Porte du placard',
				amount: 5000,
				paidBy: 'organization',
				borneBy: 'owner',
				recovery: 'owner_statement'
			});
			const { ctx, page } = await open(browser, options, manager, '/app/depenses');
			await expect(page.getByTestId('depense')).toHaveCount(1, { timeout: 20_000 });
			await page.getByTestId('ajouter-justificatif').click();
			await expect(page.getByTestId('formulaire-justificatif')).toBeVisible();
			await page
				.getByTestId('formulaire-justificatif')
				.getByTestId('justificatif-fichiers')
				.setInputFiles([
					{ name: 'devis.jpg', mimeType: 'image/jpeg', buffer: PHOTO },
					{ name: 'facture.pdf', mimeType: 'application/pdf', buffer: await onePagePdf() }
				]);
			await expect(page.getByTestId('formulaire-justificatif').getByTestId('justificatif-pieces')).toHaveText('2 pièces');
			await expectNoHorizontalOverflow(page, `Justificatif d’une dépense (gestion, ${label})`);
			await page.getByTestId('enregistrer-justificatif').click();
			await expect(page.getByTestId('formulaire-justificatif')).toHaveCount(0);
			await expect(page.getByTestId('voir-justificatif')).toBeVisible({ timeout: 45_000 });
			await expect(page.getByTestId('ajouter-justificatif')).toHaveCount(0);
			const expense = await get<{ documentId: string }>(request, agency.headers, `/expenses/${id}`);
			expect(expense.documentId).not.toBeNull();
			await page.getByTestId('voir-justificatif').click();
			expect(await openedFileHead(request, page)).toBe('%PDF-');
			await expectNoHorizontalOverflow(page, `Dépenses avec justificatif (gestion, ${label})`);
			await ctx.close();

			const reader = await open(browser, options, viewer, '/app/depenses');
			await expect(reader.page.getByTestId('justificatif-etat')).toContainText('Justificatif joint', { timeout: 20_000 });
			await expect(reader.page.getByTestId('voir-justificatif')).toHaveCount(0);
			await expect(reader.page.getByTestId('ajouter-justificatif')).toHaveCount(0);
			await reader.ctx.close();
		});
	}
});

test.describe('Relevés propriétaires', () => {
	test('préparé, émis, envoyé par WhatsApp, reversé ; page /s légère, sans téléphone de locataire ; liens révoqués', async ({
		browser,
		request
	}) => {
		test.setTimeout(5 * 60_000);
		const agency = await freshAgency(request, `Agence relevés ${newId().slice(-6)}`);
		const { leases } = await portfolio(request, agency, 2);
		await pay(request, agency, leases[0]!.leaseId, `${previousMonth}-15`);
		const { ctx, page } = await open(browser, desktop, agency.director, '/app/releves');

		await expect(page.getByTestId('releve-proprietaire')).toHaveCount(1, { timeout: 20_000 });
		await expect(page.getByTestId('releve-proprietaire')).toContainText('À préparer');
		await page.getByTestId('preparer-releve').click();
		await expect(page).toHaveURL(/\/app\/releves\/[0-9a-f-]{36}$/);
		await expect(page.getByTestId('releve-document')).toBeVisible({ timeout: 20_000 });
		await expect(page.getByTestId('releve-brouillon')).toBeVisible();
		// 80 000 encaissés, commission de 10 % sur le loyer seul (7 500) : 72 500 à reverser.
		await expect(page.getByTestId('releve-net')).toContainText(formatFcfa(72500));
		await expect(page.getByTestId('releve-document')).toContainText(leases[0]!.name);
		await expectNoHorizontalOverflow(page, 'Relevé brouillon (direction, ordinateur)');

		await page.getByTestId('emettre-releve').click();
		await expect(page.getByText('Relevé émis.')).toBeVisible({ timeout: 20_000 });
		await expect(page.getByTestId('releve-brouillon')).toHaveCount(0);
		await page.getByTestId('partager-releve').click();
		await expect(page.getByTestId('lien-releve')).toHaveText(/^http:\/\/localhost:4173\/s\/[A-Za-z0-9_-]{43}$/);
		const link = (await page.getByTestId('lien-releve').textContent())!.trim();
		const [wa] = await opened(page);
		expect(wa).toMatch(/^https:\/\/wa\.me\/22670900003\?text=/);
		expect(new URL(wa!).searchParams.get('text')).toContain(link);

		await synced(page, 20_000);
		await page.getByTestId('enregistrer-reversement').click();
		await expect(page.getByLabel('Montant reversé')).toHaveValue('72500', { timeout: 20_000 });
		await page.getByTestId('formulaire-reversement').getByRole('button', { name: 'Enregistrer un reversement' }).click();
		await expect(page.getByText('Reversement enregistré.', { exact: true })).toBeVisible();
		await expect(page.getByTestId('reste-a-reverser')).toHaveText(formatFcfa(0), { timeout: 20_000 });
		await expectNoHorizontalOverflow(page, 'Relevé émis et reversé (direction, ordinateur)');

		// Page partagée, ouverte par le propriétaire sur un téléphone, en 3G, cache vide.
		const owner = await browser.newContext({ ...phone, locale: 'fr-FR', timezoneId: 'Africa/Ouagadougou' });
		const shared = await owner.newPage();
		const cdp = await owner.newCDPSession(shared);
		await cdp.send('Network.enable');
		await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
		await cdp.send('Network.emulateNetworkConditions', {
			offline: false,
			latency: 300,
			downloadThroughput: (1.6 * 1024 * 1024) / 8,
			uploadThroughput: (750 * 1024) / 8
		});
		const scripts: string[] = [];
		shared.on('request', (r) => {
			if (r.resourceType() === 'script') scripts.push(r.url());
		});
		const t0 = Date.now();
		const response = await shared.goto(link, { waitUntil: 'load' });
		const elapsed = Date.now() - t0;
		test.info().annotations.push({ type: 'Relevé /s en 3G', description: `${elapsed} ms` });
		expect(elapsed, 'page /s chargée en moins de 3 s en 3G').toBeLessThan(3000);
		expect(response!.status()).toBe(200);
		const headers = response!.headers();
		expect(headers['cache-control']).toBe('no-store');
		expect(headers['x-robots-tag']).toBe('noindex, nofollow');
		expect(headers['referrer-policy']).toBe('no-referrer');
		expect(scripts, 'aucun JavaScript sur /s').toEqual([]);
		await expect(shared.getByTestId('releve-document')).toBeVisible();
		await expect(shared.getByTestId('releve-net')).toContainText(formatFcfa(72500));
		await expect(shared.getByTestId('releve-document')).toContainText(leases[0]!.name);
		const html = await shared.content();
		for (const l of leases) {
			const digits = l.phone.slice(4);
			for (const form of [
				l.phone,
				l.phone.slice(1),
				digits,
				`${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 6)} ${digits.slice(6)}`
			]) {
				expect(html, `téléphone du locataire (${form})`).not.toContain(form);
			}
		}
		await expect(shared.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
		await expectNoHorizontalOverflow(shared, 'Relevé partagé /s (téléphone)');

		// Profil lecture : le relevé, rien à préparer ni à émettre.
		const viewer = await addMember(request, agency, 'viewer', 'Comptable lecture');
		const asViewer = await open(browser, tablet, viewer, '/app/releves');
		await expect(asViewer.page.getByTestId('releve-proprietaire')).toContainText('Émis', { timeout: 20_000 });
		await expect(asViewer.page.getByTestId('preparer-releve')).toHaveCount(0);
		await asViewer.page.getByRole('link', { name: 'Ouvrir' }).click();
		await expect(asViewer.page.getByTestId('releve-document')).toBeVisible({ timeout: 20_000 });
		await expect(asViewer.page.getByTestId('partager-releve')).toHaveCount(0);
		await expect(asViewer.page.getByTestId('enregistrer-reversement')).toHaveCount(0);
		await expectNoHorizontalOverflow(asViewer.page, 'Relevé (lecture, tablette)');
		await asViewer.ctx.close();

		// Liens révoqués : la page dit que le lien n'est plus valable.
		await page.getByTestId('revoquer-liens').click();
		await expect(page.getByText('1 lien révoqué.')).toBeVisible();
		await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
		await shared.reload();
		await expect(shared.getByTestId('releve-introuvable')).toBeVisible();
		await expect(shared.getByTestId('releve-document')).toHaveCount(0);
		await owner.close();
		await ctx.close();
	});
});
