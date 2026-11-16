/**
 * Lot 08 bis : contrats, contre la vraie API, le vrai worker (génération par le service de conversion) et le vrai
 * service PowerSync.
 * - Sur téléphone, tablette et ordinateur, sans débordement : génération depuis la fiche bail, relecture (champs vides,
 *   aperçu, bandeau du modèle par défaut non relu), figement, dépôt du scan signé (photo et PDF réunis en un seul PDF sur
 *   l'appareil), puis avenant de loyer appliqué au bail à sa signature ; liste des contrats et modèles.
 * - Scan préparé hors ligne : il attend sur l'appareil et part à la reconnexion.
 * - Flux PowerSync : l'agent de terrain et le profil lecture ne reçoivent aucune donnée de contrat ; une autre
 *   organisation ne reçoit rien.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { addDays, addMonths, toIsoDate } from '@ziga/shared/dates';
import { newId } from '@ziga/shared/ids';
import { PDFDocument } from 'pdf-lib';
import { addMember, freshAgency, get, login, post, received, type Agency, type Member } from './agency';
import { accounts, API_URL, expectNoHorizontalOverflow, signInWith, synced } from './support';

const phone = { viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true };
const tablet = { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true };
const desktop = { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false };
const today = toIsoDate();
const PHOTO = readFileSync(join(import.meta.dirname, 'fixtures/photo.jpg'));

async function onePagePdf(): Promise<Buffer> {
	const doc = await PDFDocument.create();
	doc.addPage([595, 842]);
	return Buffer.from(await doc.save());
}

async function call(request: APIRequestContext, headers: Record<string, string>, method: 'PATCH' | 'PUT', path: string, data: unknown) {
	const r = await request.fetch(`${API_URL}${path}`, { method, headers, data });
	expect(r.status(), `${path} ${await r.text()}`).toBeLessThan(300);
}

/** Organisation complète (représentant), unité couverte par un mandat, locataire avec sa pièce, bail en vigueur. */
async function contractReady(request: APIRequestContext, agency: Agency) {
	await call(request, agency.headers, 'PATCH', '/organization', {
		address: 'Avenue Kwame Nkrumah',
		representative: { name: 'Salif Ouédraogo', title: 'gérant', idType: 'cnib', idNumber: 'B00000001', idIssuedOn: '2020-01-01' }
	});
	const ownerId = newId();
	await post(request, agency.headers, '/owners', {
		id: ownerId,
		type: 'person',
		name: 'Mariam Zongo',
		phone: '+22670900003',
		country: 'BF'
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
		name: 'Résidence du Parc',
		communeId: 'ouagadougou',
		neighborhoodId: geo.neighborhoods.find((n) => n.name === 'Tampouy')!.id
	});
	const unitId = newId();
	await post(request, agency.headers, '/units', {
		id: unitId,
		propertyId,
		type: 'apartment',
		label: `C${unitId.slice(-3)}`,
		rent: 75000,
		surfaceM2: 80,
		rooms: { bedrooms: 2, livingRooms: 1, kitchens: 1, bathrooms: 1, terraces: 0, laundries: 0 }
	});
	await post(request, agency.headers, `/properties/${propertyId}/status`, { status: 'active' });
	await post(request, agency.headers, `/units/${unitId}/status`, { status: 'active' });
	const mandateId = newId();
	await post(request, agency.headers, '/mandates', {
		id: mandateId,
		ownerId,
		type: 'rental_management',
		startsOn: addDays(today, -60),
		commission: { basis: 'percent_of_collected', rateBp: 1000 },
		canCollectFunds: true
	});
	await post(request, agency.headers, `/mandates/${mandateId}/scopes`, { id: newId(), propertyId });
	const tenantId = newId();
	await post(request, agency.headers, '/tenants', {
		id: tenantId,
		civility: 'mrs',
		fullName: 'Awa Ouédraogo',
		phone: '+22670445566',
		nationality: 'burkinabè',
		identity: {
			birthDate: '1990-04-12',
			birthPlace: 'Koudougou',
			idType: 'cnib',
			idNumber: 'B12345678',
			idIssuedOn: '2022-01-10',
			idIssuedBy: 'ONI'
		}
	});
	const leaseId = newId();
	await post(request, agency.headers, '/leases', {
		id: leaseId,
		unitId,
		tenantId,
		startsOn: today,
		durationMonths: 12,
		rent: 75000,
		charges: 0,
		lessorType: 'owner'
	});
	return { unitId, tenantId, leaseId, propertyId };
}

interface ContractApi {
	id: string;
	status: string;
	currentVersion: number;
	frozenVersion: number | null;
	generationStatus: string;
	signatureMode: string | null;
	signatureLabel: string | null;
	versions: { number: number; blankFields: string[] }[];
}

/** Attend que la génération de la version courante soit faite (worker). */
async function generatedContract(request: APIRequestContext, headers: Record<string, string>, id: string): Promise<ContractApi> {
	let c: ContractApi | null = null;
	await expect
		.poll(
			async () => {
				c = await get<ContractApi>(request, headers, `/contracts/${id}`);
				return c.generationStatus === 'idle' && c.versions.some((v) => v.number === c!.currentVersion);
			},
			{ timeout: 90_000, intervals: [1000] }
		)
		.toBe(true);
	return c!;
}

async function fillSignatureDates(page: Page) {
	for (const input of await page.locator('[data-testid^="date-"]').all()) await input.fill(today);
}

async function waitStatus(page: Page, text: string) {
	await synced(page, 20_000);
	await expect(page.getByTestId('statut-contrat')).toHaveText(text, { timeout: 30_000 });
}

async function context(browser: Browser, size: typeof phone) {
	const ctx = await browser.newContext({ ...size, locale: 'fr-FR', timezoneId: 'Africa/Ouagadougou', baseURL: 'http://localhost:4173' });
	return { ctx, page: await ctx.newPage() };
}

for (const [name, size] of [
	['téléphone', phone],
	['tablette', tablet],
	['ordinateur', desktop]
] as const) {
	test.describe(`Contrats sur ${name}`, () => {
		test.use(size);

		test(`génération, relecture, figement, dépôt du scan, avenant, sans débordement (${name})`, async ({ browser, request }) => {
			test.setTimeout(6 * 60_000);
			const agency = await freshAgency(request, `Agence contrats ${newId().slice(-6)}`);
			const manager = await addMember(request, agency, 'manager', 'Gestionnaire des contrats');
			const { leaseId } = await contractReady(request, agency);
			const { ctx, page } = await context(browser, size);
			await signInWith(page, manager, '/app/contrats');
			await synced(page);

			// Liste : le bail en vigueur sans contrat signé porte l'alerte.
			const line = page.getByTestId('ligne-contrat').filter({ has: page.getByText('Awa Ouédraogo') });
			await expect(line).toHaveAttribute('data-etat', 'none');
			await expect(line.getByTestId('alerte').first()).toHaveText('Contrat non signé');
			await expectNoHorizontalOverflow(page, `contrats (${name})`);

			// Génération depuis la fiche bail.
			await page.goto(`/app/baux/${leaseId}`);
			await synced(page);
			await page.getByTestId('generer-contrat').click();
			await expect(page.getByText('Modèle par défaut de la plateforme, pas encore relu').first()).toBeVisible();
			await page.getByLabel('Lieu de signature').fill('Ouagadougou');
			await expectNoHorizontalOverflow(page, `fiche bail, génération (${name})`);
			await page.getByRole('button', { name: 'Générer', exact: true }).click();
			await expect(page).toHaveURL(/\/app\/contrats\/[0-9a-f-]{36}$/);
			const contractId = page.url().split('/').pop()!;
			await generatedContract(request, manager.headers, contractId);

			// Relecture : aucun champ vide, bandeau du modèle par défaut, aperçu.
			await waitStatus(page, 'Brouillon');
			await expect(page.getByTestId('aucun-champ-vide')).toBeVisible({ timeout: 30_000 });
			await expect(page.getByText('Modèle par défaut de la plateforme, pas encore relu').first()).toBeVisible();
			if (name === 'ordinateur') {
				await expect(page.getByTestId('apercu-pdf')).toBeVisible({ timeout: 15_000 });
			} else {
				await page.getByTestId('ouvrir-apercu').click();
				await expect(page.getByTestId('apercu-plein-ecran')).toBeVisible();
				await expect(page.getByTestId('apercu-pdf')).toBeVisible({ timeout: 15_000 });
				await page.keyboard.press('Escape');
				await expect(page.getByTestId('apercu-plein-ecran')).toHaveCount(0);
			}
			await expectNoHorizontalOverflow(page, `contrat, relecture (${name})`);

			await page.getByTestId('soumettre').click();
			await waitStatus(page, 'En vérification');
			await page.getByTestId('figer').click();
			await waitStatus(page, 'Prêt à signer');
			await expectNoHorizontalOverflow(page, `contrat prêt à signer (${name})`);

			// Dépôt du scan : une photo et un PDF, réunis en un seul PDF sur l'appareil.
			await page.getByTestId('deposer-scan').click();
			await page.getByTestId('fichiers-scan').setInputFiles([
				{ name: 'page-1.jpg', mimeType: 'image/jpeg', buffer: PHOTO },
				{ name: 'page-2.pdf', mimeType: 'application/pdf', buffer: await onePagePdf() }
			]);
			await expect(page.getByTestId('nombre-pieces')).toHaveText('2 pièces');
			await fillSignatureDates(page);
			await expectNoHorizontalOverflow(page, `dépôt du scan (${name})`);
			await page.getByTestId('enregistrer-scan').click();
			await waitStatus(page, 'Signé');
			await expect(page.getByTestId('libelle-signature')).toContainText(
				'Signature manuscrite, scan déposé par Gestionnaire des contrats le '
			);
			await expect(page.getByTestId('suivi-legalisation')).toBeVisible();
			const signed = await get<ContractApi>(request, manager.headers, `/contracts/${contractId}`);
			expect(signed).toMatchObject({ status: 'signed', signatureMode: 'handwritten_scan' });
			expect(signed.signatureLabel).not.toMatch(/lectronique/);
			expect((await get<{ alerts: string[] }>(request, manager.headers, `/leases/${leaseId}`)).alerts).toEqual([]);
			await expectNoHorizontalOverflow(page, `contrat signé (${name})`);

			// Avenant de loyer : appliqué au bail à la signature de son contrat.
			await page.goto(`/app/baux/${leaseId}`);
			await synced(page);
			await page.getByTestId('faire-avenant').click();
			await page.getByTestId('objet-avenant').selectOption('rent_change');
			await page.getByLabel('Nouveau loyer mensuel (FCFA)').fill('80000');
			// Un début de période (mois civils : le 1er), sur lequel aucune échéance n'est encore émise.
			await page.getByLabel('Date d’effet').fill(addMonths(`${today.slice(0, 7)}-01`, 2));
			await page.getByLabel('Lieu de signature').fill('Ouagadougou');
			await expectNoHorizontalOverflow(page, `fiche bail, avenant (${name})`);
			await page.getByRole('button', { name: 'Créer l’avenant et son contrat' }).click();
			await expect(page).toHaveURL(/\/app\/contrats\/[0-9a-f-]{36}$/);
			const amendmentContract = page.url().split('/').pop()!;
			expect(amendmentContract).not.toBe(contractId);
			await generatedContract(request, manager.headers, amendmentContract);
			await waitStatus(page, 'Brouillon');
			await expect(page.getByRole('heading', { name: 'Avenant n° 1' })).toBeVisible();
			await page.getByTestId('soumettre').click();
			await waitStatus(page, 'En vérification');
			await page.getByTestId('figer').click();
			await waitStatus(page, 'Prêt à signer');
			await page.getByTestId('deposer-scan').click();
			await page
				.getByTestId('fichiers-scan')
				.setInputFiles([{ name: 'avenant.pdf', mimeType: 'application/pdf', buffer: await onePagePdf() }]);
			await fillSignatureDates(page);
			await page.getByTestId('enregistrer-scan').click();
			await waitStatus(page, 'Signé');
			// Appliqué par le même mécanisme que la route du lot 08 : une nouvelle version du bail, au nouveau loyer.
			const lease = await get<{ rent: number; version: number }>(request, manager.headers, `/leases/${leaseId}`);
			expect(lease).toMatchObject({ version: 2, rent: 80000 });
			await expectNoHorizontalOverflow(page, `avenant signé (${name})`);

			// Liste : contrat signé, avenant appliqué.
			await page.goto('/app/contrats');
			await synced(page);
			await expect(line).toHaveAttribute('data-etat', 'signed');
			await expectNoHorizontalOverflow(page, `contrats, après signature (${name})`);
			await ctx.close();

			// Modèles : réservés à la direction pour le dépôt ; modèle en usage et bandeau.
			const director = await context(browser, size);
			await signInWith(director.page, agency.director, '/app/contrats/modeles');
			await synced(director.page);
			await expect(director.page.getByTestId('en-usage-lease')).toContainText('Modèle par défaut de la plateforme, version 2');
			await expect(director.page.getByTestId('formulaire-modele')).toBeVisible();
			await expectNoHorizontalOverflow(director.page, `modèles de contrat (${name})`);
			await director.ctx.close();
		});
	});
}

test.describe('Scan signé préparé hors ligne', () => {
	test.use(phone);

	test('il attend sur l’appareil, puis part à la reconnexion : le contrat est signé', async ({ browser, request }) => {
		test.setTimeout(4 * 60_000);
		const agency = await freshAgency(request, `Agence scan ${newId().slice(-6)}`);
		const manager = await addMember(request, agency, 'manager', 'Gestionnaire hors ligne');
		const { leaseId } = await contractReady(request, agency);
		const created = await post(request, manager.headers, `/leases/${leaseId}/contract`, {
			id: newId(),
			signingPlace: 'Ouagadougou',
			signingDate: today,
			copies: 3
		});
		const id = String(created.id);
		let c = await generatedContract(request, manager.headers, id);
		await post(request, manager.headers, `/contracts/${id}/submit`, { expectedVersion: c.currentVersion });
		await post(request, manager.headers, `/contracts/${id}/freeze`, { expectedVersion: c.currentVersion });
		c = await get<ContractApi>(request, manager.headers, `/contracts/${id}`);
		expect(c.status).toBe('ready_to_sign');

		const { ctx, page } = await context(browser, phone);
		await signInWith(page, manager, `/app/contrats/${id}`);
		await waitStatus(page, 'Prêt à signer');
		await ctx.setOffline(true);
		// Hors ligne : la fiche reste lisible, les actions du serveur sont « disponibles en ligne ».
		await expect(page.getByTestId('figer')).toHaveCount(0);
		await page.getByTestId('deposer-scan').click();
		await page.getByTestId('photo-page').setInputFiles({ name: 'page.jpg', mimeType: 'image/jpeg', buffer: PHOTO });
		await fillSignatureDates(page);
		await page.getByTestId('enregistrer-scan').click();
		await expect(page.getByTestId('scan-en-file')).toContainText('Scan gardé sur l’appareil');
		expect((await get<ContractApi>(request, manager.headers, `/contracts/${id}`)).status).toBe('ready_to_sign');
		await ctx.setOffline(false);
		await waitStatus(page, 'Signé');
		await expect(page.getByTestId('scan-en-file')).toHaveCount(0);
		expect((await get<ContractApi>(request, manager.headers, `/contracts/${id}`)).status).toBe('signed');
		await ctx.close();
	});
});

test.describe('Flux PowerSync des contrats', () => {
	test('direction et gestion les reçoivent ; ni l’agent de terrain, ni le profil lecture ; B ne reçoit rien de A', async ({ request }) => {
		test.setTimeout(3 * 60_000);
		const agency = await freshAgency(request, `Agence flux contrats ${newId().slice(-6)}`);
		const manager = await addMember(request, agency, 'manager', 'Gestionnaire flux contrats');
		const agent: Member = await addMember(request, agency, 'field_agent', 'Agent flux contrats');
		const viewer: Member = await addMember(request, agency, 'viewer', 'Lecture flux contrats');
		const { leaseId, unitId } = await contractReady(request, agency);
		await post(request, agency.headers, `/units/${unitId}/assign`, { agentId: agent.userId });
		const created = await post(request, manager.headers, `/leases/${leaseId}/contract`, {
			id: newId(),
			signingPlace: 'Ouagadougou',
			signingDate: today,
			copies: 3
		});
		await generatedContract(request, manager.headers, String(created.id));
		const other = await freshAgency(request, `Agence B flux contrats ${newId().slice(-6)}`);
		const tables = ['lease_contracts', 'contract_versions', 'lease_amendments', 'contract_templates'];

		for (const who of [agency.director, manager]) {
			const rows = await received(request, await login(request, who.phone, who.password));
			expect(rows.some((r) => r.table === 'lease_contracts' && r.data.id === created.id)).toBe(true);
			expect(rows.some((r) => r.table === 'contract_versions')).toBe(true);
			// Jamais la copie des données (état civil) dans le flux : elle se lit en ligne.
			for (const r of rows.filter((x) => x.table === 'contract_versions')) expect(r.data).not.toHaveProperty('data');
		}
		for (const who of [agent, viewer]) {
			const rows = await received(request, await login(request, who.phone, who.password));
			expect(
				rows.filter((r) => tables.includes(r.table)),
				who.phone
			).toEqual([]);
			expect(rows.some((r) => r.table === 'documents' && String(r.data.type).startsWith('contract'))).toBe(false);
		}
		const b = await received(request, await login(request, other.director.phone, other.director.password));
		for (const table of [...tables, 'documents']) {
			expect(
				b.filter((r) => r.table === table && r.data.organization_id === agency.id),
				table
			).toEqual([]);
		}
	});
});
