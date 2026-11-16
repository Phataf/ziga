/**
 * Lot 08 : locataires, baux, échéances et cautions, contre la vraie API et le vrai service PowerSync.
 * - Critère d'acceptation : depuis une unité disponible, un gestionnaire crée un bail complet (nouveau locataire,
 *   caution et détenteur, avance, bail scanné) en moins de 3 minutes, sur téléphone.
 * - Deux appareils hors ligne créent un bail sur la même unité : le second est refusé à la synchronisation et apparaît
 *   dans « Modifications non acceptées » ; l'aperçu de l'échéancier hors ligne est celui que le serveur génère.
 * - Flux PowerSync : l'état civil et la pièce d'identité ne descendent que chez le directeur et le gestionnaire,
 *   jamais chez l'agent de terrain ; une autre organisation ne reçoit rien.
 * - Écrans sur téléphone, tablette et ordinateur, sans débordement horizontal, pour le directeur, le gestionnaire et
 *   l'agent de terrain.
 */
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { addDays, toIsoDate } from '@ziga/shared/dates';
import { newId } from '@ziga/shared/ids';
import { addMember, freshAgency, get, login, post, received, type Agency, type Person } from './agency';
import { accounts, API_URL, expectNoHorizontalOverflow, signInWith, synced } from './support';

const phone = { viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true };
const tablet = { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true };
const desktop = { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false };
const today = toIsoDate();
const PDF = Buffer.from('%PDF-1.7\n% bail signé, scanné\n%%EOF\n');

/** Un bien actif, couvert par un mandat de gestion, avec une unité active, prête, à 75 000 FCFA. */
async function availableUnit(request: APIRequestContext, agency: Agency, opts: { agentId?: string } = {}) {
	const ownerId = newId();
	const mandateId = newId();
	await post(request, agency.headers, '/owners', { id: ownerId, type: 'person', name: 'Mariam Zongo', phone: '+22670900003' });
	await post(request, agency.headers, '/mandates', {
		id: mandateId,
		ownerId,
		type: 'rental_management',
		startsOn: addDays(today, -30),
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
		neighborhoodId: geo.neighborhoods.find((n) => n.name === 'Tampouy')!.id
	});
	await post(request, agency.headers, `/properties/${propertyId}/status`, { status: 'active' });
	await post(request, agency.headers, `/mandates/${mandateId}/scopes`, { id: newId(), propertyId });
	const unitId = newId();
	await post(request, agency.headers, '/units', {
		id: unitId,
		propertyId,
		type: 'apartment',
		label: `A${unitId.slice(-3)}`,
		rent: 75000,
		charges: 5000,
		depositAmount: 150000,
		advanceMonths: 1
	});
	await post(request, agency.headers, `/units/${unitId}/status`, { status: 'active' });
	if (opts.agentId) await post(request, agency.headers, `/units/${unitId}/assign`, { agentId: opts.agentId });
	return { propertyId, unitId };
}

/** Un bail validé, créé par l'API, avec un locataire dont l'état civil est saisi. */
async function leaseViaApi(request: APIRequestContext, agency: Agency, unitId: string) {
	const tenantId = newId();
	await post(request, agency.headers, '/tenants', {
		id: tenantId,
		fullName: 'Awa Ouédraogo',
		phone: '+22670445566',
		identity: { birthDate: '1990-04-12', birthPlace: 'Koudougou', idType: 'cnib', idNumber: 'B12345678' }
	});
	const leaseId = newId();
	await post(request, agency.headers, '/leases', {
		id: leaseId,
		unitId,
		tenantId,
		startsOn: today,
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
	return { tenantId, leaseId };
}

/** Assistant, de l'unité jusqu'à l'étape 5 : nouveau locataire, conditions, caution, avance. */
async function wizardToDocuments(page: Page, propertyId: string, opts: { tenant: string; received?: string; advance?: string }) {
	await page.goto(`/app/biens/${propertyId}`);
	await page.getByTestId('creer-bail').click();
	await expect(page.getByTestId('assistant-bail')).toHaveAttribute('data-etape', '1');
	await page.getByLabel('Nom et prénoms').fill(opts.tenant);
	await page.getByLabel('Téléphone', { exact: true }).fill('70 11 22 33');
	await page.getByRole('button', { name: 'Enregistrer et continuer' }).click();
	await expect(page.getByTestId('assistant-bail')).toHaveAttribute('data-etape', '2');
	await expect(page.getByLabel('Loyer mensuel (FCFA)')).toHaveValue('75000');
	await page.getByRole('button', { name: 'Enregistrer et continuer' }).click();
	await expect(page.getByTestId('assistant-bail')).toHaveAttribute('data-etape', '3');
	await expect(page.getByLabel('Caution · Montant convenu (FCFA)')).toHaveValue('150000');
	// Détenteur proposé selon le mandat : il autorise l'organisation à encaisser.
	await expect(page.getByLabel('Détenteur')).toHaveValue('organization');
	if (opts.received) await page.getByLabel('Versé aujourd’hui (FCFA, facultatif)').fill(opts.received);
	await page.getByRole('button', { name: 'Enregistrer et continuer' }).click();
	await expect(page.getByTestId('assistant-bail')).toHaveAttribute('data-etape', '4');
	if (opts.advance) await page.getByLabel('Avance (mois de loyer payés d’avance)').fill(opts.advance);
	await expect(page.getByTestId('echeance-apercu').first()).toBeVisible();
	await page.getByRole('button', { name: 'Enregistrer et continuer' }).click();
	await expect(page.getByTestId('assistant-bail')).toHaveAttribute('data-etape', '5');
	return new URL(page.url()).searchParams.get('bail')!;
}

test.describe('Création d’un bail sur téléphone (critère d’acceptation du lot 08)', () => {
	test.use(phone);

	test('depuis une unité disponible, un gestionnaire crée un bail complet en moins de 3 minutes', async ({ page, request }) => {
		test.setTimeout(4 * 60_000);
		const agency = await freshAgency(request, `Agence baux ${newId().slice(-6)}`);
		const manager = await addMember(request, agency, 'manager', 'Gestionnaire des baux');
		const { propertyId, unitId } = await availableUnit(request, agency);
		await signInWith(page, manager, `/app/biens/${propertyId}`);
		await synced(page);
		const started = Date.now();

		const leaseId = await wizardToDocuments(page, propertyId, { tenant: 'Salif Traoré', received: '75 000', advance: '2' });
		await expectNoHorizontalOverflow(page, 'assistant, étape 5 (téléphone)');
		// Bail scanné : en ligne, une fois le brouillon synchronisé.
		await synced(page);
		await page
			.getByLabel('Fichier (PDF ou image, 10 Mo au plus)')
			.setInputFiles({ name: 'Bail signé.pdf', mimeType: 'application/pdf', buffer: PDF });
		await page.getByRole('button', { name: 'Envoyer le document' }).click();
		await expect(page.getByTestId('document').filter({ hasText: 'Bail signé.pdf' })).toContainText('En vigueur', { timeout: 15_000 });
		await page.getByTestId('valider').click();
		await expect(page).toHaveURL(`/app/baux/${leaseId}`);
		await synced(page);
		// Confirmé par le serveur : plus « en attente », et l'échéancier du serveur remplace l'aperçu de l'appareil.
		await expect(page.getByTestId('attente-synchro')).toHaveCount(0, { timeout: 20_000 });
		await expect(page.getByTestId('statut-bail')).toHaveText('En vigueur');
		await expect(page.getByTestId('echeance').first()).not.toHaveAttribute('data-preview', '1', { timeout: 20_000 });
		const elapsed = Date.now() - started;
		expect(elapsed, `${Math.round(elapsed / 1000)} s`).toBeLessThan(3 * 60_000);

		// Côté serveur : bail validé, échéances générées, caution et détenteur, versement, bail scanné, aucune alerte.
		const lease = await get<{
			status: string;
			tenantId: string;
			advanceMonths: number;
			rentDues: { isAdvance: boolean; dueOn: string }[];
			deposits: { holder: string; balances: { received: number; remainingDue: number } }[];
			alerts: string[];
		}>(request, manager.headers, `/leases/${leaseId}`);
		expect(lease).toMatchObject({ status: 'active', advanceMonths: 2, alerts: [] });
		expect(lease.rentDues.filter((d) => d.isAdvance)).toHaveLength(2);
		expect(lease.deposits).toEqual([
			expect.objectContaining({ holder: 'organization', balances: expect.objectContaining({ received: 75000, remainingDue: 75000 }) })
		]);
		expect(await get<{ fullName: string }>(request, manager.headers, `/tenants/${lease.tenantId}`)).toMatchObject({
			fullName: 'Salif Traoré'
		});
		// L'unité est occupée (calculée), plus disponible.
		expect(await get<{ occupancy: string; available: boolean }>(request, manager.headers, `/units/${unitId}`)).toMatchObject({
			occupancy: 'occupied',
			available: false
		});
		await expect(page.getByTestId('alerte-contrat')).toHaveCount(0);
		await expect(page.getByTestId('echeance').first()).not.toHaveAttribute('data-preview', '1');
	});
});

test.describe('Deux appareils hors ligne, un bail chacun sur la même unité (règle 8)', () => {
	test.use(phone);

	async function device(browser: Browser, who: Person, propertyId: string) {
		const context = await browser.newContext({
			...phone,
			locale: 'fr-FR',
			timezoneId: 'Africa/Ouagadougou',
			baseURL: 'http://localhost:4173'
		});
		const page = await context.newPage();
		await signInWith(page, who, `/app/biens/${propertyId}`);
		await synced(page);
		await expect(page.getByTestId('creer-bail')).toBeVisible();
		return { context, page };
	}

	test('le second est refusé à la synchronisation et apparaît dans « Modifications non acceptées » ; l’aperçu est celui du serveur', async ({
		browser,
		request
	}) => {
		test.setTimeout(4 * 60_000);
		const agency = await freshAgency(request, `Agence règle 8 ${newId().slice(-6)}`);
		const manager = await addMember(request, agency, 'manager', 'Gestionnaire second appareil');
		const { propertyId, unitId } = await availableUnit(request, agency);
		const one = await device(browser, agency.director, propertyId);
		const two = await device(browser, manager, propertyId);
		await one.context.setOffline(true);
		await two.context.setOffline(true);

		const first = await wizardToDocuments(one.page, propertyId, { tenant: 'Premier locataire' });
		await expect(one.page.getByText('Les documents privés se déposent en ligne, une fois le bail synchronisé.')).toBeVisible();
		await one.page.getByTestId('valider').click();
		await expect(one.page).toHaveURL(`/app/baux/${first}`);
		// Hors ligne : aperçu de l'échéancier, calculé par la même fonction que le serveur.
		await expect(one.page.getByTestId('echeance').first()).toBeVisible();
		const preview = await one.page.getByTestId('echeance').count();
		expect(preview).toBeGreaterThan(0);
		await expect(one.page.getByTestId('echeance').first()).toHaveAttribute('data-preview', '1');

		const second = await wizardToDocuments(two.page, propertyId, { tenant: 'Second locataire' });
		await two.page.getByTestId('valider').click();
		await expect(two.page).toHaveURL(`/app/baux/${second}`);

		// Le premier appareil revient : son bail est validé par le serveur, l'aperçu devient l'échéancier du serveur.
		await one.context.setOffline(false);
		await synced(one.page, 20_000);
		await expect(one.page.getByTestId('attente-synchro')).toHaveCount(0, { timeout: 20_000 });
		await expect(one.page.getByTestId('statut-bail')).toHaveText('En vigueur');
		await expect(one.page.getByTestId('echeance').first()).not.toHaveAttribute('data-preview', '1', { timeout: 20_000 });
		await expect(one.page.getByTestId('echeance')).toHaveCount(preview);
		const server = await get<{ status: string; rentDues: unknown[] }>(request, agency.headers, `/leases/${first}`);
		expect(server.status).toBe('active');
		expect(server.rentDues).toHaveLength(preview);

		// Le second revient : sa validation est refusée, notifiée et gardée ; le bail redevient un brouillon.
		await two.context.setOffline(false);
		const notice = two.page.getByTestId('refus-notification');
		await expect(notice).toBeVisible({ timeout: 20_000 });
		await synced(two.page, 20_000);
		await expect(two.page.getByTestId('statut-bail')).toHaveText('Brouillon');
		await notice.getByRole('link', { name: 'Voir les modifications non acceptées' }).click();
		await expect(two.page).toHaveURL('/app/modifications-non-acceptees');
		const entry = two.page.getByTestId('refus').filter({ hasText: 'Bail' });
		await expect(entry).toHaveCount(1);
		await expect(entry).toHaveAttribute('data-code', /UNIT_NOT_AVAILABLE|UNIT_ALREADY_LEASED/);
		const leases = await get<{ id: string; status: string }[]>(request, agency.headers, `/leases?unitId=${unitId}`);
		expect(leases.filter((l) => l.status === 'active').map((l) => l.id)).toEqual([first]);
		expect(leases.find((l) => l.id === second)?.status).toBe('draft');
		await one.context.close();
		await two.context.close();
	});
});

test.describe('Flux PowerSync : état civil du locataire et cloisonnement', () => {
	test('l’état civil descend chez le directeur et le gestionnaire, jamais chez l’agent de terrain ; B ne reçoit rien de A', async ({
		request
	}) => {
		const agency = await freshAgency(request, `Agence flux ${newId().slice(-6)}`);
		const manager = await addMember(request, agency, 'manager', 'Gestionnaire du flux');
		const agent = await addMember(request, agency, 'field_agent', 'Agent du flux');
		const { unitId } = await availableUnit(request, agency, { agentId: agent.userId });
		const { tenantId, leaseId } = await leaseViaApi(request, agency, unitId);
		const other = await freshAgency(request, `Agence B flux ${newId().slice(-6)}`);

		const director = await received(request, await login(request, agency.director.phone, agency.director.password));
		const asManager = await received(request, await login(request, manager.phone, manager.password));
		for (const rows of [director, asManager]) {
			expect(rows.find((r) => r.table === 'tenant_identities' && r.data.id === tenantId)?.data).toMatchObject({
				id_number: 'B12345678',
				birth_place: 'Koudougou'
			});
			expect(rows.some((r) => r.table === 'deposit_accounts')).toBe(true);
		}
		const asAgent = await received(request, await login(request, agent.phone, agent.password));
		expect(asAgent.some((r) => r.table === 'tenant_identities')).toBe(false);
		const tenantRow = asAgent.find((r) => r.table === 'tenants' && r.data.id === tenantId);
		expect(tenantRow?.data).toMatchObject({ full_name: 'Awa Ouédraogo' });
		for (const column of ['birth_date', 'birth_place', 'id_number', 'id_type', 'notes', 'user_id'])
			expect(tenantRow?.data, column).not.toHaveProperty(column);
		expect(asAgent.some((r) => r.table === 'leases' && r.data.id === leaseId)).toBe(true);
		expect(asAgent.some((r) => r.table === 'rent_dues')).toBe(true);
		expect(asAgent.some((r) => r.table === 'deposit_accounts' || r.table === 'deposit_movements')).toBe(false);
		// Jamais d'occupation ni de compte lié dans un flux.
		for (const r of director.filter((x) => x.table === 'units' || x.table === 'tenants')) {
			expect(r.data).not.toHaveProperty('occupancy');
			expect(r.data).not.toHaveProperty('user_id');
		}

		const b = await received(request, await login(request, other.director.phone, other.director.password));
		for (const table of [
			'tenants',
			'tenant_identities',
			'leases',
			'lease_versions',
			'rent_dues',
			'deposit_accounts',
			'deposit_movements'
		]) {
			expect(
				b.filter((r) => r.table === table && r.data.organization_id === agency.id),
				table
			).toEqual([]);
		}
	});
});

for (const [name, size] of [
	['téléphone', phone],
	['tablette', tablet],
	['ordinateur', desktop]
] as const) {
	test.describe(`Écrans des baux sur ${name}`, () => {
		test.use(size);

		test(`locataires, fiche locataire, fiche bail et assistant, par profil, sans débordement (${name})`, async ({ browser, request }) => {
			test.setTimeout(3 * 60_000);
			const agency = await freshAgency(request, `Agence écrans ${newId().slice(-6)}`);
			const manager = await addMember(request, agency, 'manager', 'Gestionnaire des écrans');
			const agent = await addMember(request, agency, 'field_agent', 'Agent des écrans');
			const { unitId } = await availableUnit(request, agency, { agentId: agent.userId });
			const { tenantId, leaseId } = await leaseViaApi(request, agency, unitId);
			const free = await availableUnit(request, agency);

			const open = async () => {
				const context = await browser.newContext({
					...size,
					locale: 'fr-FR',
					timezoneId: 'Africa/Ouagadougou',
					baseURL: 'http://localhost:4173'
				});
				return { context, page: await context.newPage() };
			};
			for (const who of [agency.director, manager]) {
				const { context, page } = await open();
				await signInWith(page, who, '/app/locataires');
				await synced(page);
				await expect(page.getByTestId('locataire')).toHaveCount(1);
				await expectNoHorizontalOverflow(page, `locataires (${name})`);
				await page.goto(`/app/locataires/${tenantId}`);
				await expect(page.getByTestId('numero-piece')).toHaveText('B12345678');
				await expectNoHorizontalOverflow(page, `fiche locataire (${name})`);
				await page.goto(`/app/baux/${leaseId}`);
				await expect(page.getByTestId('statut-bail')).toHaveText('En vigueur');
				await expect(page.getByTestId('alerte-contrat')).toBeVisible();
				await expect(page.getByTestId('compte-caution')).toHaveCount(1);
				await expect(page.getByTestId('echeance').first()).toBeVisible();
				await expectNoHorizontalOverflow(page, `fiche bail (${name})`);
				await page.goto(`/app/biens/${free.propertyId}`);
				await page.getByTestId('creer-bail').click();
				await expect(page.getByTestId('assistant-bail')).toHaveAttribute('data-etape', '1');
				await expectNoHorizontalOverflow(page, `assistant (${name})`);
				await context.close();
			}

			// Agent de terrain : le bail de son unité, sans caution ; le locataire, sans état civil.
			const { context, page } = await open();
			await signInWith(page, agent, `/app/baux/${leaseId}`);
			await synced(page);
			await expect(page.getByTestId('statut-bail')).toHaveText('En vigueur');
			await expect(page.getByTestId('caution')).toHaveCount(0);
			await expect(page.getByTestId('valider-bail')).toHaveCount(0);
			await expectNoHorizontalOverflow(page, `fiche bail, agent (${name})`);
			await page.goto(`/app/locataires/${tenantId}`);
			await expect(page.getByTestId('coordonnees')).toBeVisible();
			await expect(page.getByTestId('etat-civil')).toHaveCount(0);
			await expectNoHorizontalOverflow(page, `fiche locataire, agent (${name})`);
			await context.close();
		});
	});
}
