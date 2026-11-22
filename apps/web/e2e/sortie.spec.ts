/**
 * Lot 10 bis, étape 4 : écrans de la sortie du locataire, contre la vraie API, le vrai service PowerSync et le vrai
 * worker (tâche du jour), sur les trois appareils. Points du porteur :
 * - sortie complète, du préavis à la restitution, sur téléphone, tablette et ordinateur : bouton « Préavis » de la fiche
 *   bail, état des lieux pièce par pièce (« bon état » seul refusé), cases cochées (« Case cochée par … sur l'appareil
 *   de … »), décompte de l'exemple du porteur (deux lignes justifiées, 85 000 FCFA restitués ; une retenue sans montant
 *   ni devis impossible à l'écran ; sur ordinateur, tableau et panneau des justificatifs à droite), fin du bail par la
 *   tâche du jour, unité « à remettre en état » jamais disponible avant d'être déclarée prête ;
 * - cas contesté : la part non contestée restituée sans attendre, jamais au-delà ; clôture avec l'issue et son document ;
 * - agent de terrain, téléphone, hors ligne : état des lieux de 4 pièces avec photos en moins de 15 minutes, signé par
 *   les cases cochées, envoyé au retour du réseau ; jamais de décompte ;
 * - imputation sur loyer : ce qui restera pour les dégâts, et une part gardée ;
 * - sans débordement horizontal sur téléphone.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import { addDays, addMonths, monthDay, toIsoDate } from '@ziga/shared/dates';
import { newId } from '@ziga/shared/ids';
import { formatFcfa } from '@ziga/shared/money';
import { newReceiptToken, provisionalReceiptNumber } from '@ziga/shared/payments';
import { PDFDocument } from 'pdf-lib';
import { addMember, availableUnit, freshAgency, get, post, type Agency, type Person } from './agency';
import { expectNoHorizontalOverflow, signInWith, synced } from './support';

const phone = { viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true };
const tablet = { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true };
const desktop = { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false };
const devices: [string, BrowserContextOptions, 'phone' | 'tablet' | 'desktop'][] = [
	['Téléphone (360 × 800)', phone, 'phone'],
	['Tablette (820 × 1180)', tablet, 'tablet'],
	['Ordinateur (1440 × 900)', desktop, 'desktop']
];
const today = toIsoDate();
const [ty, tm] = today.split('-').map(Number) as [number, number];
const PHOTO = readFileSync(join(import.meta.dirname, 'fixtures/photo.jpg'));
const DAILY = resolve(import.meta.dirname, '../../api/scripts/e2e-leases-daily.mjs');

async function pdf(): Promise<Buffer> {
	const doc = await PDFDocument.create();
	doc.addPage([595, 842]);
	return Buffer.from(await doc.save());
}

/** La vraie tâche du jour, dans le worker des tests (apps/api/scripts/e2e-leases-daily.mjs). */
function runDaily(): Record<string, number> {
	return JSON.parse(
		execFileSync(process.execPath, [DAILY, today], { encoding: 'utf8', cwd: resolve(import.meta.dirname, '../../api') })
	) as Record<string, number>;
}

async function pay(request: APIRequestContext, agency: Agency, leaseId: string, amount: number, extra: Record<string, unknown> = {}) {
	const receiptId = newId();
	await post(request, agency.headers, '/payments', {
		payments: [
			{
				id: newId(),
				leaseId,
				purpose: 'rent',
				amount,
				method: 'cash',
				paidOn: today,
				receiptId,
				provisionalNumber: provisionalReceiptNumber(receiptId),
				verificationToken: newReceiptToken(),
				shareToken: newReceiptToken(),
				...extra
			}
		]
	});
}

/**
 * Bail en vigueur depuis trois mois (75 000 + 5 000), caution de 100 000 reçue et détenue par l'organisation, loyers à
 * jour. Avec `notice`, le congé du locataire est déjà enregistré (sortie aujourd'hui).
 */
async function exitingLease(request: APIRequestContext, agency: Agency, opts: { agentId?: string; notice?: boolean } = {}) {
	const { propertyId, unitId } = await availableUnit(request, agency, opts);
	const tenantId = newId();
	const tenantName = `Salif Traoré ${tenantId.slice(-4)}`;
	await post(request, agency.headers, '/tenants', { id: tenantId, fullName: tenantName, phone: '+22670445599' });
	const leaseId = newId();
	await post(request, agency.headers, '/leases', {
		id: leaseId,
		unitId,
		tenantId,
		startsOn: monthDay(ty, tm, -3, 1),
		rent: 75000,
		charges: 5000,
		lessorType: 'owner'
	});
	const accountId = newId();
	await post(request, agency.headers, '/deposit-accounts', {
		id: accountId,
		leaseId,
		type: 'security_deposit',
		agreedAmount: 100000,
		holder: 'organization'
	});
	await pay(request, agency, leaseId, 100000, { purpose: 'deposit', depositAccountId: accountId });
	const lease = await get<{ rentDues: { periodStart: string; amountDue: number; amountPaid: number; status: string }[] }>(
		request,
		agency.headers,
		`/leases/${leaseId}`
	);
	// Les mois passés seulement : le mois de la sortie est payé après la fin du bail, au prorata (pas de trop-perçu).
	const owed = lease.rentDues
		.filter((d) => d.status !== 'waived' && d.periodStart < monthDay(ty, tm, 0, 1))
		.reduce((s, d) => s + d.amountDue - d.amountPaid, 0);
	if (owed > 0) await pay(request, agency, leaseId, owed);
	if (opts.notice) {
		await post(request, agency.headers, `/leases/${leaseId}/notice`, {
			id: newId(),
			origin: 'tenant',
			deliveryMode: 'hand_delivery',
			notifiedOn: addDays(addMonths(today, -3), 1),
			plannedExitOn: today
		});
	}
	return { propertyId, unitId, tenantId, tenantName, leaseId, accountId };
}

/** À la date de sortie : la tâche du jour termine le bail (dernier mois au prorata, suivants abandonnés), puis le reste dû est payé. */
async function endAndSettleRent(request: APIRequestContext, agency: Agency, leaseId: string) {
	runDaily();
	const lease = await get<{ status: string; rentDues: { amountDue: number; amountPaid: number; status: string }[] }>(
		request,
		agency.headers,
		`/leases/${leaseId}`
	);
	expect(lease.status).toBe('ended');
	const owed = lease.rentDues.filter((d) => d.status !== 'waived').reduce((s, d) => s + d.amountDue - d.amountPaid, 0);
	if (owed > 0) await pay(request, agency, leaseId, owed);
}

/** Devis déposé par l'API (justificatif d'une retenue). */
async function uploadQuote(request: APIRequestContext, agency: Agency, subject: { leaseId: string; propertyId: string; unitId: string }) {
	const id = newId();
	const buffer = await pdf();
	const created = (await post(request, agency.headers, '/documents', {
		id,
		type: 'repair_quote',
		...subject,
		fileName: 'devis.pdf',
		mimeType: 'application/pdf',
		byteSize: buffer.length
	})) as { upload: { url: string } };
	expect((await request.put(created.upload.url, { data: buffer, headers: { 'content-type': 'application/pdf' } })).status()).toBe(200);
	await post(request, agency.headers, `/documents/${id}/uploaded`, {});
	return id;
}

async function open(browser: Browser, options: BrowserContextOptions, who: Person, target: string) {
	const ctx = await browser.newContext({ ...options, locale: 'fr-FR', timezoneId: 'Africa/Ouagadougou' });
	await ctx.addInitScript(() => {
		window.open = (() => null) as typeof window.open;
	});
	const page = await ctx.newPage();
	await signInWith(page, who, target);
	await expect(page).toHaveURL(target);
	await synced(page, 20_000);
	return { ctx, page };
}

/** Un élément de l'état des lieux : constat (sortie), description ; enregistré sur l'appareil en quittant le champ. */
async function fillElement(
	page: Page,
	element: string,
	finding: 'normal_wear' | 'tenant_damage' | 'landlord_defect',
	text: string,
	nth = 0
) {
	const card = page.locator(`[data-testid="element"][data-element="${element}"]`).nth(nth);
	await card.getByTestId(`constat-${finding}`).check();
	await card.getByTestId('description').fill(text);
	await card.getByTestId('description').blur();
	await expect(card.getByText('Enregistré.')).toBeVisible({ timeout: 10_000 });
	return card;
}

async function addRoom(page: Page, room: string) {
	await page.locator('#nouvelle-piece').selectOption(room);
	await page.getByTestId('ajouter-piece-valider').click();
	await expect(page.getByTestId('piece').getByRole('heading', { name: new RegExp(`: ${room}$`) })).toBeVisible();
}

async function exitView(request: APIRequestContext, agency: Agency, leaseId: string) {
	return get<{
		inspections: { id: string; type: string; status: string; items: unknown[] }[];
		settlements: { status: string; refund: number }[];
	}>(request, agency.headers, `/leases/${leaseId}/exit`);
}

test.describe('Sortie complète, du préavis à la restitution, sur les trois appareils', () => {
	for (const [label, options, kind] of devices) {
		test(`gestion, ${label} : préavis, état des lieux, décompte de l’exemple du porteur, restitution, remise en état`, async ({
			browser,
			request
		}) => {
			test.setTimeout(5 * 60_000);
			const agency = await freshAgency(request, `Agence sortie ${newId().slice(-6)}`);
			const manager = await addMember(request, agency, 'manager', 'Gestionnaire de la sortie');
			const { leaseId, unitId, tenantName } = await exitingLease(request, agency);
			const { ctx, page } = await open(browser, options, manager, `/app/baux/${leaseId}`);

			// 1. Préavis : bouton de la fiche bail ; délai et fin du loyer calculés comme le serveur.
			await page.getByTestId('preavis').click();
			await page.getByTestId('conge-notifie').fill(addDays(addMonths(today, -3), 1));
			await page.getByTestId('conge-sortie').fill(today);
			await expect(page.getByTestId('conge-apercu')).toContainText('Préavis de 3 mois');
			await expectNoHorizontalOverflow(page, `Congé (${label})`);
			await page.getByTestId('enregistrer-conge').click();
			await expect(page.getByTestId('ouvrir-sortie')).toBeVisible({ timeout: 20_000 });
			await page.getByTestId('ouvrir-sortie').click();
			await expect(page.getByTestId('sortie-conge')).toContainText('Le locataire');

			// 2. État des lieux de sortie, pièce par pièce.
			await page.getByTestId('commencer-edl').click();
			await expect(page.getByTestId('etat-des-lieux')).toBeVisible();
			await addRoom(page, 'Couloir');
			// « Bon état » seul : refusé, pas enregistré.
			const vague = page.locator('[data-testid="element"][data-element="floor"]');
			await vague.getByTestId('constat-normal_wear').check();
			await vague.getByTestId('description').fill('Bon état');
			await vague.getByTestId('description').blur();
			await expect(vague.getByTestId('refus-element')).toContainText('« bon état » seul ne suffit pas');
			await fillElement(page, 'floor', 'normal_wear', 'Carrelage terne, usure de passage normale');
			await fillElement(page, 'door', 'tenant_damage', 'Porte fendue sur toute la hauteur, gond arraché');
			await fillElement(page, 'walls_paint', 'normal_wear', 'Peinture jaunie, quelques traces de meubles');
			await fillElement(page, 'lights', 'landlord_defect', 'Douille ancienne, fils apparents au plafond');
			await page.locator('#nouvel-element').selectOption('shower');
			await page.getByRole('button', { name: 'Ajouter un élément' }).click();
			await fillElement(page, 'shower', 'tenant_damage', 'Pommeau de douche arraché, flexible coupé');
			await expectNoHorizontalOverflow(page, `État des lieux (${label})`);
			await page.getByTestId('cocher-organization').click();
			await page.getByTestId('cocher-tenant').click();
			await expect(page.getByTestId('libelle-case-tenant')).toContainText(`Case cochée par ${tenantName} le `);
			await expect(page.getByTestId('libelle-case-tenant')).toContainText('sur l’appareil de Gestionnaire de la sortie');
			await expect(page.getByTestId('signatures')).not.toContainText(/électronique/i);
			await synced(page, 20_000);
			await expect(page.getByTestId('edl-fige')).toBeVisible({ timeout: 20_000 });
			await expect
				.poll(async () => (await exitView(request, agency, leaseId)).inspections.find((i) => i.type === 'exit')?.status, {
					timeout: 20_000
				})
				.toBe('signed_both');

			// 3. À la date de sortie, la tâche du jour termine le bail (échéances suivantes abandonnées, unité à remettre en
			// état) ; puis le décompte : retenue impossible sans montant ni devis ; deux réparations justifiées ; 85 000 restitués.
			await endAndSettleRent(request, agency, leaseId);
			await page.getByTestId('terminer-edl').click();
			await page.getByTestId('ouvrir-decompte').click();
			await page.getByTestId('preparer-decompte').click();
			await expect(page.getByTestId('a-restituer')).toHaveText(formatFcfa(100000), { timeout: 20_000 });
			for (const [element, amount] of [
				['Couloir · Douche', '10000'],
				['Couloir · Porte', '5000']
			] as const) {
				await page.getByTestId('chiffrer-reparation').click();
				const form = page.getByTestId('formulaire-reparation');
				await form.locator('#reparation-element').selectOption({ label: element });
				await form.getByTestId('reparation-description').fill('Remplacement par un artisan');
				await expect(form.getByTestId('retenue-impossible')).toBeVisible();
				await expect(form.getByTestId('enregistrer-reparation')).toBeDisabled();
				await form.getByTestId('reparation-montant').fill(amount);
				await expect(form.getByTestId('enregistrer-reparation')).toBeDisabled();
				await form
					.getByTestId('reparation-devis')
					.getByTestId('justificatif-fichiers')
					.setInputFiles({ name: 'devis.pdf', mimeType: 'application/pdf', buffer: await pdf() });
				await expect(form.getByTestId('retenue-impossible')).toHaveCount(0);
				await form.getByTestId('enregistrer-reparation').click();
				await expect(form).toBeHidden({ timeout: 20_000 });
			}
			await expect(page.getByTestId('ligne-decompte')).toHaveCount(2, { timeout: 20_000 });
			await expect(page.locator('[data-testid="ligne-decompte"][data-kept="oui"]')).toHaveCount(2);
			await expect(page.getByTestId('a-restituer')).toHaveText(formatFcfa(85000), { timeout: 20_000 });
			if (kind === 'desktop') {
				await expect(page.getByTestId('panneau-justificatifs')).toBeVisible();
				await expect(page.getByTestId('panneau-justificatifs').getByTestId('voir-justificatif')).toHaveCount(2);
				await expect(page.locator('table').getByTestId('ligne-decompte')).toHaveCount(2);
			} else {
				await expect(page.getByTestId('panneau-justificatifs')).toHaveCount(0);
				await expect(page.getByTestId('lignes-decompte').getByTestId('voir-justificatif')).toHaveCount(2);
			}
			await expectNoHorizontalOverflow(page, `Décompte (${label})`);
			await page.getByTestId('proposer-decompte').click();
			await expect(page.getByTestId('accepter-decompte')).toBeVisible({ timeout: 20_000 });
			await page.getByTestId('accepter-decompte').click();
			await expect(page.getByTestId('clore-decompte')).toBeVisible({ timeout: 20_000 });
			await page.getByTestId('clore-decompte').click();
			await page.locator('#restitution-moyen').selectOption('mobile_money');
			await page.locator('#restitution-reference').fill('OM-4471');
			await expectNoHorizontalOverflow(page, `Restitution (${label})`);
			await page.getByTestId('enregistrer-restitution').click();
			await expect(page.getByTestId('sortie-close')).toBeVisible({ timeout: 20_000 });
			await expect(page.getByTestId('mouvement')).toHaveCount(4, { timeout: 20_000 });
			await expect(page.getByTestId('mouvements-caution')).toContainText('Restitution · 85');

			// 4. Bail terminé par la tâche du jour : l'unité est à remettre en état, jamais disponible avant d'être prête.
			await page.goto('/app/sorties');
			await synced(page, 20_000);
			const card = page
				.getByTestId('unite-a-remettre')
				.filter({ hasText: (await get<{ label: string }>(request, agency.headers, `/units/${unitId}`)).label });
			await expect(card).toBeVisible({ timeout: 20_000 });
			await expect(card).toContainText('Pas disponible');
			await expect(page.getByTestId('sortie-close')).toHaveCount(1);
			expect((await get<{ technicalStatus: string }>(request, agency.headers, `/units/${unitId}`)).technicalStatus).toBe('to_refurbish');
			await expectNoHorizontalOverflow(page, `Sorties (${label})`);
			await card.getByTestId('declarer-prete').click();
			await expect(card).toHaveCount(0, { timeout: 20_000 });
			await synced(page, 20_000);
			await expect
				.poll(async () => (await get<{ technicalStatus: string }>(request, agency.headers, `/units/${unitId}`)).technicalStatus, {
					timeout: 20_000
				})
				.toBe('ready');
			await ctx.close();
		});
	}
});

test.describe('Décompte le jour de la sortie, sans la tâche du jour', () => {
	test('tablette : préparé avant la tâche de nuit, aucun mois suivant compté impayé ; restitution juste, bail terminé', async ({
		browser,
		request
	}) => {
		test.setTimeout(4 * 60_000);
		const agency = await freshAgency(request, `Agence jour J ${newId().slice(-6)}`);
		const manager = await addMember(request, agency, 'manager', 'Gestionnaire du jour J');
		const { leaseId, accountId, propertyId, unitId } = await exitingLease(request, agency, { notice: true });
		// Le locataire a payé tout le mois de sa sortie.
		const dues = await get<{ rentDues: { amountDue: number; amountPaid: number; status: string; periodStart: string }[] }>(
			request,
			agency.headers,
			`/leases/${leaseId}`
		);
		const owed = dues.rentDues
			.filter((d) => d.status !== 'waived' && d.periodStart <= today)
			.reduce((s, d) => s + d.amountDue - d.amountPaid, 0);
		if (owed > 0) await pay(request, agency, leaseId, owed);
		void accountId;
		const inspectionId = newId();
		await post(request, agency.headers, '/inspections', { id: inspectionId, leaseId, type: 'exit', inspectedOn: today });
		const quote = await uploadQuote(request, agency, { leaseId, propertyId, unitId });
		for (const [element, amount] of [
			['shower', 10000],
			['door', 5000]
		] as const) {
			const itemId = newId();
			await post(request, agency.headers, `/inspections/${inspectionId}/items`, {
				id: itemId,
				room: 'Douche et WC',
				element,
				description: `${element} : cassé, à remplacer entièrement`,
				finding: 'tenant_damage'
			});
			await post(request, agency.headers, '/repairs', {
				id: newId(),
				inspectionItemId: itemId,
				description: 'Remplacer',
				performedBy: 'organization',
				estimatedAmount: amount,
				quoteDocumentId: quote
			});
		}
		await post(request, agency.headers, `/inspections/${inspectionId}/sign`, { party: 'organization' });
		await post(request, agency.headers, `/inspections/${inspectionId}/sign`, { party: 'tenant' });

		const { ctx, page } = await open(browser, tablet, manager, `/app/sorties/${leaseId}/decompte`);
		await page.getByTestId('preparer-decompte').click();
		await expect(page.getByTestId('ligne-decompte')).toHaveCount(2, { timeout: 20_000 });
		const after = await get<{ status: string; rentDues: { amountDue: number; periodStart: string; periodEnd: string; status: string }[] }>(
			request,
			agency.headers,
			`/leases/${leaseId}`
		);
		expect(after.status).toBe('ended');
		expect(after.rentDues.filter((d) => d.periodStart > today).every((d) => d.status === 'waived')).toBe(true);
		const last = after.rentDues.find((d) => d.periodStart <= today && d.periodEnd >= today)!;
		const excess = 80000 - last.amountDue;
		await expect(page.locator('[data-testid="ligne-decompte"][data-kept="oui"]')).toHaveCount(2);
		await expect(page.getByTestId('a-restituer')).toHaveText(formatFcfa(85000 + excess), { timeout: 20_000 });
		await expect(page.getByTestId('lignes-decompte')).not.toContainText('Loyer et charges impayés');
		await expectNoHorizontalOverflow(page, 'Décompte le jour de la sortie (tablette)');
		await ctx.close();
	});
});

test.describe('Décompte contesté', () => {
	test('ordinateur : part non contestée restituée sans attendre, jamais au-delà ; clôture avec l’issue et son document', async ({
		browser,
		request
	}) => {
		test.setTimeout(4 * 60_000);
		const agency = await freshAgency(request, `Agence contestation ${newId().slice(-6)}`);
		const manager = await addMember(request, agency, 'manager', 'Gestionnaire contestation');
		const { leaseId, accountId, propertyId, unitId } = await exitingLease(request, agency, { notice: true });
		// État des lieux et réparation par l'API : porte à 30 000 FCFA, avec son devis.
		const inspectionId = newId();
		await post(request, agency.headers, '/inspections', { id: inspectionId, leaseId, type: 'exit', inspectedOn: today });
		const itemId = newId();
		await post(request, agency.headers, `/inspections/${inspectionId}/items`, {
			id: itemId,
			room: 'Salon',
			element: 'door',
			description: 'Porte d’entrée enfoncée, serrure cassée',
			finding: 'tenant_damage'
		});
		await post(request, agency.headers, `/inspections/${inspectionId}/sign`, { party: 'organization' });
		await post(request, agency.headers, `/inspections/${inspectionId}/sign`, { party: 'tenant' });
		const quote = newId();
		const buffer = await pdf();
		const created = (await post(request, agency.headers, '/documents', {
			id: quote,
			type: 'repair_quote',
			leaseId,
			propertyId,
			unitId,
			fileName: 'devis.pdf',
			mimeType: 'application/pdf',
			byteSize: buffer.length
		})) as { upload: { url: string } };
		expect((await request.put(created.upload.url, { data: buffer, headers: { 'content-type': 'application/pdf' } })).status()).toBe(200);
		await post(request, agency.headers, `/documents/${quote}/uploaded`, {});
		await post(request, agency.headers, '/repairs', {
			id: newId(),
			inspectionItemId: itemId,
			description: 'Changer la porte',
			performedBy: 'organization',
			estimatedAmount: 30000,
			quoteDocumentId: quote
		});
		await endAndSettleRent(request, agency, leaseId);
		const settlement = (await post(request, agency.headers, `/deposit-accounts/${accountId}/settlement`, {})) as { id: string };
		await post(request, agency.headers, `/deposit-settlements/${settlement.id}/propose`, {});

		const { ctx, page } = await open(browser, desktop, manager, `/app/sorties/${leaseId}/decompte`);
		await expect(page.getByTestId('a-restituer')).toHaveText(formatFcfa(70000), { timeout: 20_000 });
		await page.getByTestId('contester-decompte').click();
		await page.getByTestId('contestation-observations').fill('La porte était déjà abîmée à l’entrée');
		await page.getByTestId('enregistrer-contestation').click();
		await expect(page.getByTestId('part-non-contestee')).toContainText(formatFcfa(70000), { timeout: 20_000 });
		// Jamais au-delà : le serveur refuse 70 001.
		await page.getByTestId('restituer-part').click();
		await page.getByTestId('restitution-montant').fill('70001');
		await page.getByTestId('enregistrer-restitution').click();
		await expect(page.getByTestId('formulaire-restitution')).toContainText(/au-delà|dépasse|reste/i, { timeout: 20_000 });
		await page.getByTestId('restitution-montant').fill('70000');
		await page.getByTestId('enregistrer-restitution').click();
		await expect(page.getByTestId('deja-restitue')).toContainText(formatFcfa(70000), { timeout: 20_000 });
		await expect(page.getByTestId('part-non-contestee')).toHaveCount(0);
		await expectNoHorizontalOverflow(page, 'Décompte contesté (ordinateur)');
		await page.getByTestId('clore-issue').click();
		await page.locator('#restitution-issue').selectOption('amicable_agreement');
		await page
			.getByTestId('issue-document')
			.getByTestId('justificatif-fichiers')
			.setInputFiles({ name: 'accord.pdf', mimeType: 'application/pdf', buffer });
		await page.getByTestId('enregistrer-restitution').click();
		await expect(page.getByTestId('sortie-close')).toBeVisible({ timeout: 20_000 });
		await expect
			.poll(async () => (await exitView(request, agency, leaseId)).settlements.at(-1)?.status, { timeout: 20_000 })
			.toBe('closed');
		await ctx.close();
	});

	test('téléphone : l’imputation sur loyer montre ce qui restera pour les dégâts et garde une part', async ({ browser, request }) => {
		test.setTimeout(3 * 60_000);
		const agency = await freshAgency(request, `Agence imputation ${newId().slice(-6)}`);
		const manager = await addMember(request, agency, 'manager', 'Gestionnaire imputation');
		const { propertyId, unitId } = await availableUnit(request, agency);
		void propertyId;
		const tenantId = newId();
		await post(request, agency.headers, '/tenants', { id: tenantId, fullName: 'Rasmata Zongo', phone: '+22670445598' });
		const leaseId = newId();
		await post(request, agency.headers, '/leases', {
			id: leaseId,
			unitId,
			tenantId,
			startsOn: monthDay(ty, tm, -1, 1),
			rent: 75000,
			charges: 5000,
			lessorType: 'owner'
		});
		const accountId = newId();
		await post(request, agency.headers, '/deposit-accounts', {
			id: accountId,
			leaseId,
			type: 'security_deposit',
			agreedAmount: 100000,
			holder: 'organization'
		});
		await pay(request, agency, leaseId, 100000, { purpose: 'deposit', depositAccountId: accountId });
		await post(request, agency.headers, `/leases/${leaseId}/notice`, {
			id: newId(),
			origin: 'tenant',
			deliveryMode: 'hand_delivery',
			notifiedOn: today,
			plannedExitOn: addMonths(today, 3)
		});
		await post(request, agency.headers, `/deposit-accounts/${accountId}/settlement`, {});
		const { ctx, page } = await open(browser, phone, manager, `/app/sorties/${leaseId}/decompte`);
		await page.getByTestId('nouvel-accord-loyer').click({ timeout: 20_000 });
		const form = page.getByTestId('formulaire-accord');
		const plan = form.getByTestId('reste-degats');
		await expect(plan).toContainText('il restera');
		await form.getByTestId('accord-garde').fill('40000');
		await expect(plan).toContainText(`il restera ${formatFcfa(40000)}`);
		await expectNoHorizontalOverflow(page, 'Accord d’imputation (téléphone)');
		await form.getByTestId('enregistrer-accord').click();
		await expect(page.getByTestId('accord')).toHaveCount(1, { timeout: 20_000 });
		await expect(page.getByTestId('accord')).toContainText('Proposé');
		await ctx.close();
	});
});

test.describe('État des lieux hors ligne par l’agent de terrain', () => {
	test('téléphone : 4 pièces avec photos en moins de 15 minutes, cases cochées, envoyé au retour du réseau ; jamais le décompte', async ({
		browser,
		request
	}) => {
		test.setTimeout(6 * 60_000);
		const agency = await freshAgency(request, `Agence terrain ${newId().slice(-6)}`);
		const agent = await addMember(request, agency, 'field_agent', 'Agente de terrain');
		const { leaseId, tenantName } = await exitingLease(request, agency, { notice: true, agentId: agent.userId });
		const { ctx, page } = await open(browser, phone, agent, `/app/sorties/${leaseId}`);
		await expect(page.getByTestId('sortie-decompte')).toContainText('Le décompte de caution est préparé par la gestion.');
		await expect(page.getByTestId('ouvrir-decompte')).toHaveCount(0);
		await page.getByTestId('commencer-edl').click();
		await expect(page.getByTestId('etat-des-lieux')).toBeVisible();

		const started = Date.now();
		await ctx.setOffline(true);
		const rooms: [string, string[]][] = [
			['Salon', ['door', 'walls_paint', 'floor', 'switches_outlets', 'lights', 'windows', 'fan_ac']],
			['Chambre', ['door', 'walls_paint', 'floor', 'switches_outlets', 'lights', 'windows', 'cupboards', 'mosquito_nets']],
			['Cuisine', ['door', 'walls_paint', 'floor', 'switches_outlets', 'lights', 'sink', 'taps', 'cupboards', 'drains']],
			['Douche et WC', ['door', 'walls_paint', 'floor', 'lights', 'shower', 'toilet', 'taps', 'drains']]
		];
		let total = 0;
		for (const [room, elements] of rooms) {
			await addRoom(page, room);
			for (const element of elements) {
				const damaged = room === 'Douche et WC' && element === 'shower';
				await fillElement(
					page,
					element,
					damaged ? 'tenant_damage' : 'normal_wear',
					damaged ? 'Pommeau arraché, flexible coupé net' : `${room} : traces d’usage, rien de cassé`
				);
				total += 1;
			}
			// Une photo prise sur place par pièce, gardée sur l'appareil.
			const first = page.locator(`[data-testid="element"][data-element="${elements[0]}"]`);
			await first.getByTestId('photo').setInputFiles({ name: 'piece.jpg', mimeType: 'image/jpeg', buffer: PHOTO });
			await expect(first.getByTestId('photo-en-attente')).toHaveCount(1, { timeout: 10_000 });
		}
		await page.getByTestId('cocher-organization').click();
		await page.getByTestId('cocher-tenant').click();
		await expect(page.getByTestId('libelle-case-organization')).toContainText('Case cochée par Agente de terrain le ');
		await expect(page.getByTestId('libelle-case-tenant')).toContainText(`Case cochée par ${tenantName} le `);
		await expect(page.getByTestId('libelle-case-tenant')).toContainText('sur l’appareil de Agente de terrain');
		const elapsed = Date.now() - started;
		expect(elapsed, `${total} éléments et 4 photos en ${Math.round(elapsed / 1000)} s`).toBeLessThan(15 * 60_000);
		await expectNoHorizontalOverflow(page, 'État des lieux hors ligne (agent, téléphone)');

		await ctx.setOffline(false);
		await synced(page, 30_000);
		await expect
			.poll(
				async () => {
					const exit = (await exitView(request, agency, leaseId)).inspections.find((i) => i.type === 'exit');
					return exit ? [exit.status, exit.items.length] : null;
				},
				{ timeout: 30_000 }
			)
			.toEqual(['signed_both', total]);
		await expect(page.getByTestId('photo-en-attente')).toHaveCount(0, { timeout: 60_000 });
		const documents = await get<{ type: string; status: string }[]>(request, agency.headers, '/documents');
		expect(documents.filter((d) => d.type === 'inspection_photo' && d.status === 'active')).toHaveLength(4);
		await expect(page.getByTestId('edl-fige')).toBeVisible({ timeout: 20_000 });
		await page.goto(`/app/sorties/${leaseId}/decompte`);
		await expect(page.getByTestId('a-restituer')).toHaveCount(0);
		await ctx.close();
	});
});
