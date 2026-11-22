/**
 * Lot 10 ter, étape 3b : espace du propriétaire, sur les trois appareils (docs/UX.md §8), sans débordement sur téléphone.
 * Une personne, propriétaire chez deux agences (fiches liées par le vrai parcours : invitation SMS, code validé) et
 * bailleur particulier de sa propre organisation (liée d'elle-même, réponse 2) :
 * - Patrimoine : tous ses biens sur un même écran, avec le gestionnaire de chacun, en moins de 3 secondes en 3G ; le
 *   bail en cours ne montre que le nom du locataire (réponse 5), jamais son numéro.
 * - Revenus par mois et par bien (rendement net ÷ encaissé), relevé émis avec son PDF, reversement.
 * - Contrats et documents : le bail signé, jamais la pièce d'identité du locataire (D22) ; consultation par lien signé.
 * Données préparées par l'API, contre la vraie API et le vrai service PowerSync.
 */
import { expect, test, type APIRequestContext, type BrowserContextOptions } from '@playwright/test';
import { addDays, monthDay, toIsoDate } from '@ziga/shared/dates';
import { newId } from '@ziga/shared/ids';
import { formatFcfa } from '@ziga/shared/money';
import { newReceiptToken, provisionalReceiptNumber } from '@ziga/shared/payments';
import type { StatementDetailView } from '@ziga/shared/statements';
import { PDFDocument } from 'pdf-lib';
import { freshAgency, get, post, type Agency } from './agency';
import { linkRecord, ownerInAgency, ownLandlord, personHeaders, propertyOf } from './portals';
import { API_URL, expectNoHorizontalOverflow, registerViaApi, signInWith } from './support';

const phone = { viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true };
const tablet = { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true };
const desktop = { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false };
const devices: [string, BrowserContextOptions][] = [
	['Téléphone (360 × 800)', phone],
	['Tablette (820 × 1180)', tablet],
	['Ordinateur (1440 × 900)', desktop]
];
const today = toIsoDate();
const [ty, tm] = today.split('-').map(Number) as [number, number];
const previousMonth = addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
const TENANT_PHONE = '+22670445566';

async function pdf(): Promise<Buffer> {
	const doc = await PDFDocument.create();
	doc.addPage([595, 842]);
	return Buffer.from(await doc.save());
}

async function uploadDocument(request: APIRequestContext, agency: Agency, type: string, subject: Record<string, string>) {
	const id = newId();
	const buffer = await pdf();
	const created = (await post(request, agency.headers, '/documents', {
		id,
		type,
		...subject,
		fileName: `${type}.pdf`,
		mimeType: 'application/pdf',
		byteSize: buffer.length
	})) as { upload: { url: string } };
	expect((await request.put(created.upload.url, { data: buffer, headers: { 'content-type': 'application/pdf' } })).status()).toBe(200);
	await post(request, agency.headers, `/documents/${id}/uploaded`, {});
	return id;
}

/** Agence A : bail en cours depuis le mois dernier, loyer payé, relevé émis (PDF prêt), reversement, bail signé déposé. */
async function agencyWithIncome(request: APIRequestContext, person: Awaited<ReturnType<typeof registerViaApi>>, name: string) {
	const agency = await freshAgency(request, name);
	const { ownerId, propertyId, unitId } = await ownerInAgency(request, agency, person, { property: 'Immeuble Wend-Panga', unit: 'A1' });
	const tenantId = newId();
	await post(request, agency.headers, '/tenants', {
		id: tenantId,
		fullName: 'Awa Ouédraogo',
		phone: TENANT_PHONE,
		identity: { birthDate: '1990-04-12', birthPlace: 'Koudougou', idType: 'cnib', idNumber: 'B12345678' }
	});
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
	await post(request, agency.headers, '/deposit-accounts', {
		id: newId(),
		leaseId,
		type: 'security_deposit',
		agreedAmount: 150000,
		holder: 'organization'
	});
	const receiptId = newId();
	await post(request, agency.headers, '/payments', {
		payments: [
			{
				id: newId(),
				leaseId,
				purpose: 'rent',
				amount: 80000,
				method: 'cash',
				paidOn: monthDay(ty, tm, -1, 5),
				receiptId,
				provisionalNumber: provisionalReceiptNumber(receiptId),
				verificationToken: newReceiptToken(),
				shareToken: newReceiptToken()
			}
		]
	});
	const draft = (await post(request, agency.headers, '/owner-statements/generate', { ownerId, month: previousMonth })) as {
		id: string;
		revision: string;
	};
	await post(request, agency.headers, `/owner-statements/${draft.id}/issue`, { revision: draft.revision });
	await expect
		.poll(async () => (await get<StatementDetailView>(request, agency.headers, `/owner-statements/${draft.id}`)).pdfAvailable, {
			timeout: 30_000
		})
		.toBe(true);
	const statement = await get<StatementDetailView>(request, agency.headers, `/owner-statements/${draft.id}`);
	expect(statement.totals.net).toBeGreaterThan(0);
	await post(request, agency.headers, '/owner-payouts', {
		id: newId(),
		statementId: draft.id,
		amount: statement.totals.net,
		paidOn: today,
		method: 'mobile_money'
	});
	await uploadDocument(request, agency, 'signed_lease_scan', { leaseId, propertyId, unitId });
	await uploadDocument(request, agency, 'tenant_identity', { leaseId, tenantId });
	return { agency, ownerId, net: statement.totals.net };
}

test.describe('Espace du propriétaire (lot 10 ter, étape 3b)', () => {
	for (const [label, options] of devices) {
		test(`${label} : patrimoine de trois gestionnaires en moins de 3 s en 3G, revenus, relevé, reversement, documents`, async ({
			browser,
			request,
			browserName
		}) => {
			test.setTimeout(4 * 60_000);
			const suffix = newId().slice(-6);
			const person = await registerViaApi(request, 'Rasmané Compaoré');
			const a = await agencyWithIncome(request, person, `Agence Wend-Panga ${suffix}`);
			await linkRecord(request, a.agency, person, 'owner', a.ownerId);
			const b = await freshAgency(request, `Agence Nong-Taaba ${suffix}`);
			const inB = await ownerInAgency(request, b, person, { property: 'Cour Nong-Taaba', unit: 'B1' });
			await linkRecord(request, b, person, 'owner', inB.ownerId);
			const own = await ownLandlord(request, person, `Rasmané Compaoré ${suffix}`);
			await propertyOf(request, own.agency, own.ownerId, { property: 'Villa familiale', unit: 'Villa' });
			// Sa propre fiche se lie d'elle-même à la lecture de ses liens (réponse 2).
			const mine = (await (await request.get(`${API_URL}/me/person-links`, { headers: await personHeaders(request, person) })).json()) as {
				organizationId: string;
				status: string;
			}[];
			expect(
				mine
					.filter((l) => l.status === 'active')
					.map((l) => l.organizationId)
					.sort()
			).toEqual([a.agency.id, b.id, own.agency.id].sort());

			const ctx = await browser.newContext({ ...options, locale: 'fr-FR', timezoneId: 'Africa/Ouagadougou' });
			const page = await ctx.newPage();
			await signInWith(page, person, '/espace/proprietaire');
			await expect(page).toHaveURL('/espace/proprietaire');
			const managers = page.getByTestId('gestionnaire');
			await expect(managers).toHaveCount(3, { timeout: 20_000 });

			// 1. Tous ses biens sur un même écran, en moins de 3 secondes en 3G (réseau ralenti, application déjà chargée).
			if (browserName === 'chromium') {
				const cdp = await ctx.newCDPSession(page);
				await cdp.send('Network.enable');
				// Profil « 3G » des outils de développement de Chrome : 1,6 Mbit/s descendant, 750 kbit/s montant, 300 ms.
				await cdp.send('Network.emulateNetworkConditions', {
					offline: false,
					latency: 300,
					downloadThroughput: (1.6 * 1024 * 1024) / 8,
					uploadThroughput: (750 * 1024) / 8
				});
				const started = Date.now();
				await page.reload();
				await expect(managers).toHaveCount(3, { timeout: 10_000 });
				await expect(page.getByTestId('bien-proprietaire')).toHaveCount(3);
				const elapsed = Date.now() - started;
				test.info().annotations.push({ type: '3G', description: `patrimoine affiché en ${elapsed} ms` });
				expect(elapsed, `patrimoine affiché en ${elapsed} ms en 3G`).toBeLessThan(3000);
				await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
			}
			await expect(page.getByTestId('patrimoine-totaux')).toHaveText('3 biens · 3 unités · 1 louée');
			const agencyA = managers.filter({ hasText: `Géré par Agence Wend-Panga ${suffix}` });
			await expect(agencyA.getByTestId('situation-unite')).toHaveAttribute('data-situation', 'occupied');
			await expect(agencyA.getByTestId('locataire-unite')).toContainText('Awa Ouédraogo');
			await expect(agencyA).toContainText(`${formatFcfa(150000)}, détenue par Agence Wend-Panga ${suffix}`);
			await expect(managers.filter({ hasText: `Géré par Agence Nong-Taaba ${suffix}` })).toContainText('Cour Nong-Taaba');
			await expect(managers.filter({ hasText: 'Géré par vous-même' })).toContainText('Villa familiale');
			const body = await page.locator('main').innerText();
			expect(body).not.toContain('70 44 55 66');
			expect(body).not.toContain(TENANT_PHONE);
			await expectNoHorizontalOverflow(page, `Patrimoine (${label})`);

			// 2. Revenus : le mois du relevé émis ; le bien de l'agence A avec son rendement.
			await page.goto('/espace/proprietaire/revenus');
			await expect(page.getByTestId('revenu-mois')).toHaveCount(1, { timeout: 20_000 });
			await expect(page.getByTestId('revenu-mois')).toContainText(formatFcfa(a.net));
			await expect(page.getByTestId('revenu-bien').filter({ hasText: 'Immeuble Wend-Panga' }).getByTestId('rendement')).toHaveText(/%$/);
			await expectNoHorizontalOverflow(page, `Revenus (${label})`);

			// 3. Relevés : le relevé émis, son PDF ouvert par un lien signé.
			await page.goto('/espace/proprietaire/releves');
			const statement = page.getByTestId('releve');
			await expect(statement).toHaveCount(1, { timeout: 20_000 });
			await expect(statement).toContainText(`Agence Wend-Panga ${suffix}`);
			const popup = ctx.waitForEvent('page');
			await statement.getByTestId('releve-pdf').click();
			expect((await popup).url()).not.toBe('about:blank');
			await expectNoHorizontalOverflow(page, `Relevés (${label})`);

			// 4. Reversements : celui du relevé.
			await page.goto('/espace/proprietaire/reversements');
			await expect(page.getByTestId('reversement')).toHaveCount(1, { timeout: 20_000 });
			await expect(page.getByTestId('reversement')).toContainText(formatFcfa(a.net));
			await expectNoHorizontalOverflow(page, `Reversements (${label})`);

			// 5. Contrats et documents : le bail signé, jamais la pièce d'identité du locataire.
			await page.goto('/espace/proprietaire/documents');
			const docs = page.getByTestId('document-proprietaire');
			await expect(docs).toHaveCount(1, { timeout: 20_000 });
			await expect(docs).toHaveAttribute('data-type', 'signed_lease_scan');
			const opened = ctx.waitForEvent('page');
			await docs.getByTestId('document-consulter').click();
			expect((await opened).url()).not.toBe('about:blank');
			await expectNoHorizontalOverflow(page, `Contrats et documents (${label})`);
			await ctx.close();
		});
	}
});
