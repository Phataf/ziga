/**
 * Lot 07 : biens, unités, photos et documents, contre la vraie API, le vrai worker (variantes WebP) et le vrai service
 * PowerSync.
 * - Critère d'acceptation : sur téléphone, un gestionnaire crée un immeuble de 6 appartements avec 3 photos chacun en
 *   moins de 10 minutes (assistant en cinq étapes, brouillon enregistré à chaque étape).
 * - Photo prise hors ligne : affichée en attente, envoyée à la reconnexion.
 * - Agent de terrain : ses unités affectées seulement ; il en change l'état technique.
 * - Écrans sur téléphone, tablette et ordinateur, sans débordement horizontal ; bouton global « Créer ».
 * - Back-office : quartiers avec la vérification sur place.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { addDays, toIsoDate } from '@ziga/shared/dates';
import { newId } from '@ziga/shared/ids';
import { accounts, API_URL, expectNoHorizontalOverflow, registerViaApi, signIn, signInWith, synced } from './support';

const phone = { viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true };
const tablet = { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true };
const desktop = { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false };
const PHOTO = readFileSync(new URL('./fixtures/photo.jpg', import.meta.url));
const today = toIsoDate();

async function login(request: APIRequestContext, phoneNumber: string, password: string): Promise<string> {
	const r = await request.post(`${API_URL}/auth/login`, { data: { phone: phoneNumber, password } });
	expect(r.status()).toBe(200);
	return ((await r.json()) as { accessToken: string }).accessToken;
}

type Person = Awaited<ReturnType<typeof registerViaApi>>;
interface Agency {
	id: string;
	director: Person;
	headers: Record<string, string>;
}

/** Agence neuve en formule Pro (plusieurs membres, assez d'unités), avec sa directrice. */
async function freshAgency(request: APIRequestContext, name: string): Promise<Agency> {
	const director = await registerViaApi(request, `Directrice ${name}`);
	const token = await login(request, director.phone, director.password);
	const id = newId();
	const created = await request.post(`${API_URL}/organizations`, {
		headers: { Authorization: `Bearer ${token}` },
		data: { id, type: 'agency', legalName: name, phone: '+22625300000', commune: 'Ouagadougou' }
	});
	expect(created.status()).toBe(201);
	const admin = await login(request, accounts.admin.phone, accounts.admin.password);
	const plan = await request.put(`${API_URL}/admin/organizations/${id}/plan`, {
		headers: { Authorization: `Bearer ${admin}` },
		data: { planId: 'pro', reason: 'Test de bout en bout : biens et unités' }
	});
	expect(plan.status()).toBe(204);
	return { id, director, headers: { Authorization: `Bearer ${token}`, 'X-Organization-Id': id } };
}

async function addMember(
	request: APIRequestContext,
	agency: Agency,
	role: 'manager' | 'field_agent',
	name: string
): Promise<Person & { userId: string }> {
	const person = await registerViaApi(request, name);
	const invitation = await request.post(`${API_URL}/organization/invitations`, {
		headers: agency.headers,
		data: { phone: person.phone, role }
	});
	expect(invitation.status()).toBe(201);
	const token = await login(request, person.phone, person.password);
	const { token: link } = (await invitation.json()) as { token: string };
	expect((await request.post(`${API_URL}/invitations/${link}/accept`, { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(
		200
	);
	const me = (await (await request.get(`${API_URL}/me`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { id: string };
	return { ...person, userId: me.id };
}

async function post(request: APIRequestContext, agency: Agency, path: string, data: Record<string, unknown>) {
	const r = await request.post(`${API_URL}${path}`, { headers: agency.headers, data });
	expect(r.status(), `${path} ${await r.text()}`).toBeLessThan(300);
	return r.json() as Promise<Record<string, unknown>>;
}

async function ownerWithMandate(request: APIRequestContext, agency: Agency, name: string) {
	const ownerId = newId();
	const mandateId = newId();
	await post(request, agency, '/owners', { id: ownerId, type: 'person', name, phone: '+22670900003' });
	await post(request, agency, '/mandates', {
		id: mandateId,
		ownerId,
		type: 'rental_management',
		startsOn: addDays(today, -10),
		commission: { basis: 'percent_of_collected', rateBp: 1000 },
		canPublish: true,
		canTakePhotos: true
	});
	return { ownerId, mandateId };
}

async function tampouy(request: APIRequestContext, agency: Agency): Promise<string> {
	const admin = await login(request, accounts.admin.phone, accounts.admin.password);
	const geo = (await (await request.get(`${API_URL}/admin/geography`, { headers: { Authorization: `Bearer ${admin}` } })).json()) as {
		neighborhoods: { id: string; name: string }[];
	};
	void agency;
	return geo.neighborhoods.find((n) => n.name === 'Tampouy')!.id;
}

/** Bien actif avec ses unités, créé par l'API (données de départ). */
async function propertyWithUnits(request: APIRequestContext, agency: Agency, labels: string[]) {
	const { ownerId } = await ownerWithMandate(request, agency, 'Propriétaire de départ');
	const propertyId = newId();
	await post(request, agency, '/properties', {
		id: propertyId,
		ownerId,
		type: 'apartment_building',
		name: `Immeuble ${propertyId.slice(-4)}`,
		communeId: 'ouagadougou',
		neighborhoodId: await tampouy(request, agency)
	});
	await post(request, agency, `/properties/${propertyId}/status`, { status: 'active' });
	const units: string[] = [];
	for (const label of labels) {
		const id = newId();
		await post(request, agency, '/units', { id, propertyId, type: 'apartment', label, rent: 80000 });
		units.push(id);
	}
	return { propertyId, units };
}

const shell = (page: Page, name: 'telephone' | 'tablette' | 'ordinateur') => expect(page.locator(`[data-coque="${name}"]`)).toBeVisible();
const files = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `photo-${i + 1}.jpg`, mimeType: 'image/jpeg', buffer: PHOTO }));

test.describe('Assistant d’ajout d’un bien sur téléphone (critère d’acceptation du lot 07)', () => {
	test.use(phone);

	test('un gestionnaire crée un immeuble de 6 appartements avec 3 photos chacun en moins de 10 minutes', async ({ page, request }) => {
		test.setTimeout(10 * 60_000);
		const agency = await freshAgency(request, `Agence biens ${newId().slice(-6)}`);
		const manager = await addMember(request, agency, 'manager', 'Gestionnaire des biens');
		await ownerWithMandate(request, agency, 'Salif Compaoré');
		await signInWith(page, manager, '/app/biens');
		await synced(page);
		await shell(page, 'telephone');
		await expectNoHorizontalOverflow(page, 'liste vide (téléphone)');
		const started = Date.now();

		// 1. Type et propriétaire : le bien naît en brouillon, couvert par le mandat.
		await page.getByRole('link', { name: 'Ajouter un bien' }).click();
		await expect(page.getByTestId('assistant')).toHaveAttribute('data-etape', '1');
		await page.getByLabel('Type de bien').selectOption('apartment_building');
		await page.getByLabel('Nom interne').fill('Immeuble Tampouy');
		await page.getByLabel('Propriétaire', { exact: true }).selectOption({ label: 'Salif Compaoré' });
		await page.getByLabel('Mandat qui couvre ce bien').selectOption({ index: 1 });
		await expectNoHorizontalOverflow(page, 'assistant, étape 1');
		await page.getByRole('button', { name: 'Enregistrer et continuer' }).click();

		// 2. Localisation.
		await expect(page.getByTestId('assistant')).toHaveAttribute('data-etape', '2');
		await page.getByLabel('Commune').selectOption({ label: 'Ouagadougou' });
		await page.getByLabel('Quartier', { exact: true }).selectOption({ label: 'Tampouy' });
		await page.getByLabel('Adresse ou repère').fill('Derrière la pharmacie du marché, portail bleu');
		await page.getByLabel('Titre foncier').check();
		await expectNoHorizontalOverflow(page, 'assistant, étape 2');
		await page.getByRole('button', { name: 'Enregistrer et continuer' }).click();

		// 3. Six appartements d'un coup.
		await expect(page.getByTestId('assistant')).toHaveAttribute('data-etape', '3');
		await page.getByLabel('Type d’unité').selectOption('apartment');
		await page.getByLabel('Combien ?').fill('6');
		await page.getByLabel('Loyer affiché (FCFA par mois)').fill('85 000');
		await page.getByLabel('Chambres').fill('2');
		await page.getByRole('button', { name: 'Ajouter 6 unités' }).click();
		await expect(page.getByTestId('unite-ajoutee')).toHaveCount(6);
		await expectNoHorizontalOverflow(page, 'assistant, étape 3');
		await page.getByRole('button', { name: 'Enregistrer et continuer' }).click();

		// 4. Trois photos par appartement, compressées sur le téléphone puis envoyées.
		await expect(page.getByTestId('assistant')).toHaveAttribute('data-etape', '4');
		const galleries = page.getByTestId('galerie-unite');
		await expect(galleries).toHaveCount(6);
		for (let i = 0; i < 6; i += 1) {
			await galleries.nth(i).getByTestId('galerie-unite-fichier').setInputFiles(files(3));
			await expect(galleries.nth(i).getByTestId('galerie-unite-photo')).toHaveCount(3);
		}
		await expectNoHorizontalOverflow(page, 'assistant, étape 4');
		await page.getByRole('button', { name: 'Enregistrer et continuer' }).click();

		// 5. Documents (en ligne) puis fin : le bien et ses unités sont activés ; rien n'est publié.
		await expect(page.getByTestId('assistant')).toHaveAttribute('data-etape', '5');
		await page.getByTestId('terminer').click();
		await expect(page).toHaveURL(/\/app\/biens\/[0-9a-f-]+$/);
		const elapsed = Date.now() - started;
		expect(elapsed, `durée : ${Math.round(elapsed / 1000)} s`).toBeLessThan(10 * 60_000);

		// Côté serveur : le bien actif, ses 6 unités actives et disponibles, 18 photos traitées (variantes WebP).
		const propertyId = page.url().split('/').pop()!;
		const token = await login(request, manager.phone, manager.password);
		const headers = { Authorization: `Bearer ${token}`, 'X-Organization-Id': agency.id };
		await expect
			.poll(
				async () => {
					const p = (await (await request.get(`${API_URL}/properties/${propertyId}`, { headers })).json()) as {
						recordStatus: string;
						units: { available: boolean }[];
					};
					return `${p.recordStatus}:${p.units.length}:${p.units.filter((u) => u.available).length}`;
				},
				{ timeout: 30_000 }
			)
			.toBe('active:6:6');
		await expect(page.getByTestId('unite')).toHaveCount(6);
		await expect
			.poll(async () => page.locator('[data-testid="galerie-unite-photo"][data-status="ready"]').count(), { timeout: 120_000 })
			.toBe(18);
		await expectNoHorizontalOverflow(page, 'fiche du bien (téléphone)');
		await page.goto('/app/biens');
		await expect(page.getByTestId('bien')).toHaveCount(1);
		await expectNoHorizontalOverflow(page, 'liste des biens (téléphone)');
	});

	test('une photo prise hors ligne s’affiche en attente, puis part à la reconnexion', async ({ page, context, request }) => {
		test.setTimeout(3 * 60_000);
		const agency = await freshAgency(request, `Agence photo hors ligne ${newId().slice(-6)}`);
		const { propertyId } = await propertyWithUnits(request, agency, ['H1']);
		await signInWith(page, agency.director, `/app/biens/${propertyId}`);
		await synced(page);
		await expect(page.getByTestId('unite')).toHaveCount(1);

		await context.setOffline(true);
		await expect(page.getByTestId('etat-synchro')).toHaveAttribute('data-etat', 'offline');
		await page.getByTestId('galerie-unite-fichier').setInputFiles(files(1));
		const photo = page.getByTestId('galerie-unite-photo');
		await expect(photo).toHaveCount(1);
		await expect(photo.getByTestId('galerie-unite-etat')).toHaveText('En attente d’envoi');
		await expect(photo.locator('img')).toBeVisible();

		await context.setOffline(false);
		await expect(photo).toHaveAttribute('data-status', 'ready', { timeout: 90_000 });
	});
});

test.describe('Agent de terrain : ses unités affectées seulement', () => {
	test.use(phone);

	test('il ne voit que son unité et son bien, et en change l’état technique', async ({ page, request }) => {
		const agency = await freshAgency(request, `Agence affectation ${newId().slice(-6)}`);
		const agent = await addMember(request, agency, 'field_agent', 'Agent de terrain');
		const { propertyId, units } = await propertyWithUnits(request, agency, ['T1', 'T2']);
		await propertyWithUnits(request, agency, ['Ailleurs']);
		await post(request, agency, `/units/${units[0]}/assign`, { agentId: agent.userId });

		await signInWith(page, agent, '/app/biens');
		await synced(page);
		await expect(page.getByTestId('bien')).toHaveCount(1);
		await expect(page.getByRole('button', { name: 'Ajouter un bien' })).toHaveCount(0);
		await page.getByTestId('bien').click();
		await expect(page).toHaveURL(`/app/biens/${propertyId}`);
		await expect(page.getByTestId('unite')).toHaveCount(1);
		await expect(page.getByTestId('unite')).toContainText('T1');
		await expect(page.getByTestId('documents')).toHaveCount(0);

		await page.getByRole('button', { name: 'Changer l’état technique' }).click();
		const form = page.getByTestId('etat-technique');
		await form.getByLabel('État technique').selectOption('to_refurbish');
		await form.getByLabel('Motif').fill('Peinture à refaire');
		await form.getByRole('button', { name: 'Enregistrer' }).click();
		await expect(page.getByTestId('dimensions')).toContainText('À remettre en état');
		const token = await login(request, agent.phone, agent.password);
		await expect
			.poll(async () => {
				const u = (await (
					await request.get(`${API_URL}/units/${units[0]}`, {
						headers: { Authorization: `Bearer ${token}`, 'X-Organization-Id': agency.id }
					})
				).json()) as {
					technicalStatus: string;
				};
				return u.technicalStatus;
			})
			.toBe('to_refurbish');
		await expectNoHorizontalOverflow(page, 'fiche du bien (agent, téléphone)');
	});
});

for (const [name, size, coque] of [
	['tablette', tablet, 'tablette'],
	['ordinateur', desktop, 'ordinateur']
] as const) {
	test.describe(`Biens sur ${name}`, () => {
		test.use(size);

		test(`liste, fiche et assistant sans débordement ; bouton « Créer » (${name})`, async ({ page, request }) => {
			const agency = await freshAgency(request, `Agence ${name} ${newId().slice(-6)}`);
			const { propertyId } = await propertyWithUnits(request, agency, ['A1', 'A2', 'A3']);
			await signInWith(page, agency.director, '/app/biens');
			await synced(page);
			await shell(page, coque);
			await expect(page.getByTestId('bien')).toHaveCount(1);
			await expectNoHorizontalOverflow(page, `liste (${name})`);
			await expect(page.getByTestId('bouton-creer')).toBeVisible();
			await page.goto(`/app/biens/${propertyId}`);
			await expect(page.getByTestId('unite')).toHaveCount(3);
			await expect(page.getByTestId('dimensions').first()).toContainText('Non publiée');
			await expectNoHorizontalOverflow(page, `fiche (${name})`);
			await page.getByTestId('bouton-creer').click();
			await expect(page.getByTestId('assistant')).toHaveAttribute('data-etape', '1');
			await expectNoHorizontalOverflow(page, `assistant (${name})`);
		});
	});
}

test.describe('Back-office : quartiers', () => {
	for (const [name, size] of [
		['téléphone', phone],
		['ordinateur', desktop]
	] as const) {
		test.describe(name, () => {
			test.use(size);
			test(`liste avec la vérification sur place, sans débordement (${name})`, async ({ page }) => {
				await signIn(page, 'admin', '/admin/quartiers');
				await expect(page.getByTestId('quartier').filter({ hasText: 'Bendogo' })).toContainText('Sans point');
				await expect(page.getByTestId('quartier').filter({ hasText: 'Tampouy' })).toContainText('Non');
				await expectNoHorizontalOverflow(page, `quartiers (${name})`);
			});
		});
	}

	test.describe('ajout par l’assistance', () => {
		test.use(desktop);
		test('l’assistance ajoute un quartier ; il apparaît sans vérification', async ({ page }) => {
			await signIn(page, 'support', '/admin/quartiers');
			const name = `Quartier e2e ${newId().slice(-6)}`;
			await page.getByRole('button', { name: 'Ajouter un quartier' }).click();
			const form = page.getByTestId('formulaire-quartier');
			await form.getByLabel('Commune').selectOption({ label: 'Saaba' });
			await form.getByLabel('Quartier', { exact: true }).fill(name);
			await form.getByRole('button', { name: 'Enregistrer' }).click();
			await expect(page.getByTestId('quartier').filter({ hasText: name })).toContainText('Sans point');
		});
	});
});
