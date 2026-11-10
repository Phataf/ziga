/**
 * Lot 06 : propriétaires et mandats, contre la vraie API et le vrai service PowerSync.
 * - Critère d'acceptation : un gestionnaire crée un propriétaire et son mandat de gestion en moins d'une minute, sur
 *   téléphone, hors ligne ; la synchronisation les envoie à la reconnexion.
 * - Aucune invitation ni aucun SMS envoyé au propriétaire.
 * - Modification d'un mandat : nouvelle version, historique ; révocation motivée.
 * - Agent de terrain : lecture seule. Bailleur particulier : ni propriétaires ni mandats à gérer.
 * - Bandeau « mandat expirant » à 30 jours ; écrans sur téléphone, tablette et ordinateur sans débordement.
 */
import { existsSync, readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { addDays, toIsoDate } from '@ziga/shared/dates';
import { newId } from '@ziga/shared/ids';
import { accounts, API_URL, expectNoHorizontalOverflow, registerViaApi, signInWith, SMS_FILE, synced } from './support';

const phone = { viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true };
const desktop = { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false };
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

/** Agence neuve en formule Pro (plusieurs membres), avec sa directrice. */
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
		data: { planId: 'pro', reason: 'Test de bout en bout : plusieurs membres' }
	});
	expect(plan.status()).toBe(204);
	return { id, director, headers: { Authorization: `Bearer ${token}`, 'X-Organization-Id': id } };
}

/** Un membre invité par la directrice, qui accepte. */
async function addMember(request: APIRequestContext, agency: Agency, role: 'manager' | 'field_agent', name: string): Promise<Person> {
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
	return person;
}

/** Propriétaire et mandat de gestion créés par l'API (données de départ d'un test). */
async function ownerWithMandate(request: APIRequestContext, agency: Agency, name: string, endsOn: string | null = null) {
	const ownerId = newId();
	const mandateId = newId();
	expect(
		(
			await request.post(`${API_URL}/owners`, {
				headers: agency.headers,
				data: { id: ownerId, type: 'person', name, phone: '+22670900002' }
			})
		).status()
	).toBe(201);
	expect(
		(
			await request.post(`${API_URL}/mandates`, {
				headers: agency.headers,
				data: {
					id: mandateId,
					ownerId,
					type: 'rental_management',
					startsOn: addDays(today, -30),
					endsOn,
					commission: { basis: 'percent_of_collected', rateBp: 1000 },
					canPublish: true,
					canCollectFunds: true
				}
			})
		).status()
	).toBe(201);
	return { ownerId, mandateId };
}

/** SMS envoyés à ce numéro (le fichier reçoit aussi ceux des autres tests, qui tournent en parallèle). */
const smsTo = (e164: string) =>
	existsSync(SMS_FILE)
		? readFileSync(SMS_FILE, 'utf8')
				.trim()
				.split('\n')
				.filter(Boolean)
				.filter((line) => (JSON.parse(line) as { to: string }).to === e164).length
		: 0;
const shell = (page: Page, name: 'telephone' | 'tablette' | 'ordinateur') => expect(page.locator(`[data-coque="${name}"]`)).toBeVisible();

test.describe('Propriétaires sur téléphone, hors ligne (critère d’acceptation du lot 06)', () => {
	test.use(phone);

	test('un gestionnaire crée un propriétaire et son mandat en moins d’une minute, hors ligne ; aucune invitation', async ({
		page,
		context,
		request
	}) => {
		const agency = await freshAgency(request, `Agence propriétaires ${newId().slice(-6)}`);
		const manager = await addMember(request, agency, 'manager', 'Gestionnaire hors ligne');
		await signInWith(page, manager, '/app/proprietaires');
		await synced(page);
		await shell(page, 'telephone');

		await context.setOffline(true);
		await expect(page.getByTestId('etat-synchro')).toHaveAttribute('data-etat', 'offline');
		const started = Date.now();
		await page.getByRole('link', { name: 'Nouveau propriétaire' }).click();
		await page.getByLabel('Nom ou raison sociale').fill('Rasmané Ouédraogo');
		await page.getByLabel('Téléphone', { exact: true }).fill('70 44 55 66');
		// Valeurs proposées : gestion locative dès aujourd'hui, 10 % des loyers encaissés.
		await expect(page.getByLabel('Type de mandat')).toHaveValue('rental_management');
		await expect(page.getByLabel('Taux (%)')).toHaveValue('10');
		await expectNoHorizontalOverflow(page, 'Nouveau propriétaire, téléphone');
		await page.getByRole('button', { name: 'Enregistrer' }).click();
		await expect(page).toHaveURL(/\/app\/proprietaires\/[0-9a-f-]+$/);
		await expect(page.getByText('Enregistré sur l’appareil : envoyé dès que la connexion revient.')).toBeVisible();
		const mandate = page.getByTestId('mandat');
		await expect(mandate).toContainText('Gestion locative');
		await expect(mandate.getByTestId('statut-mandat')).toHaveText('En vigueur');
		await expect(mandate).toContainText('10 % des loyers encaissés');
		expect(Date.now() - started).toBeLessThan(60_000);
		await expectNoHorizontalOverflow(page, 'Fiche propriétaire, téléphone');

		// Reconnexion : la fiche et le mandat arrivent en base ; aucun SMS, aucune invitation.
		await context.setOffline(false);
		await synced(page);
		const ownerId = new URL(page.url()).pathname.split('/').at(-1)!;
		const server = await request.get(`${API_URL}/owners/${ownerId}`, { headers: agency.headers });
		expect(server.status()).toBe(200);
		expect(await server.json()).toMatchObject({
			name: 'Rasmané Ouédraogo',
			phone: '+22670445566',
			mandates: [
				{
					type: 'rental_management',
					version: 1,
					status: 'active',
					commission: { basis: 'percent_of_collected', rateBp: 1000 },
					canSignLeases: false
				}
			]
		});
		// Aucun SMS au propriétaire, ni à la création, ni à la synchronisation.
		expect(smsTo('+22670445566')).toBe(0);
		const invitations = (await (await request.get(`${API_URL}/organization/invitations`, { headers: agency.headers })).json()) as unknown[];
		expect(invitations).toEqual([]);
	});
});

test.describe('Mandats : versions, révocation, lecture seule, alerte (lot 06)', () => {
	test.use(desktop);

	test('modifier un mandat crée la version 2 (l’historique garde la 1) ; révoquer exige un motif', async ({ page, request }) => {
		const agency = await freshAgency(request, `Agence versions ${newId().slice(-6)}`);
		const { ownerId } = await ownerWithMandate(request, agency, 'Propriétaire versionné');
		await signInWith(page, agency.director, `/app/proprietaires/${ownerId}`);
		await synced(page);
		const card = page.getByTestId('mandat');
		await expect(card).toContainText('Version 1');

		await card.getByRole('button', { name: 'Modifier' }).click();
		await expect(page.getByText('Ces changements créent la version 2 du mandat')).toBeVisible();
		await page.getByLabel('Taux (%)').fill('8');
		await page.getByRole('button', { name: 'Enregistrer' }).click();
		await expect(card).toContainText('8 % des loyers encaissés');
		await expect(card).toContainText('Version 2', { timeout: 15_000 });

		await card.getByRole('button', { name: 'Historique' }).click();
		const versions = page.getByTestId('version');
		await expect(versions).toHaveCount(2);
		await expect(versions.nth(0)).toContainText('Version 2');
		await expect(versions.nth(0)).toContainText('8 % des loyers encaissés');
		await expect(versions.nth(1)).toContainText('Version 1');
		await expect(versions.nth(1)).toContainText('10 % des loyers encaissés');
		await page.keyboard.press('Escape');

		await card.getByRole('button', { name: 'Révoquer' }).click();
		await page.getByRole('dialog').getByRole('button', { name: 'Révoquer' }).click();
		await expect(page.getByText('Indiquez le motif de la révocation (5 caractères au moins).')).toBeVisible();
		await page.getByLabel('Motif de la révocation').fill('Fin de collaboration');
		await page.getByRole('dialog').getByRole('button', { name: 'Révoquer' }).click();
		await expect(card.getByTestId('statut-mandat')).toHaveText('Révoqué');
		await expect(card.getByTestId('autorisations')).toHaveText('Aucune autorisation en vigueur');
		await expect(card).toContainText('Version 3', { timeout: 15_000 });
		await expect(card.getByRole('button', { name: 'Modifier' })).toHaveCount(0);
		const server = (await (await request.get(`${API_URL}/owners/${ownerId}`, { headers: agency.headers })).json()) as {
			mandates: { status: string; revocationReason: string; canPublish: boolean }[];
		};
		expect(server.mandates[0]).toMatchObject({ status: 'revoked', revocationReason: 'Fin de collaboration', canPublish: false });
	});

	test('agent de terrain : lecture seule ; bandeau à 30 jours de la fin ; recherche sans accents', async ({ page, request }) => {
		const agency = await freshAgency(request, `Agence alerte ${newId().slice(-6)}`);
		const { ownerId } = await ownerWithMandate(request, agency, 'Éléonore Kaboré', addDays(today, 10));
		await ownerWithMandate(request, agency, 'Paul Sawadogo');
		const agent = await addMember(request, agency, 'field_agent', 'Agent de terrain');
		await signInWith(page, agent, '/app/proprietaires');
		await synced(page);
		await expect(
			page.getByText('Consultation seulement : votre rôle ne permet pas de modifier les propriétaires ni les mandats.')
		).toBeVisible();
		await expect(page.getByRole('link', { name: 'Nouveau propriétaire' })).toHaveCount(0);
		const banner = page.getByTestId('bandeau-mandats');
		await expect(banner).toContainText('Un mandat se termine dans les 30 jours');
		await expect(banner).toContainText('Éléonore Kaboré : fin le');
		await expect(banner).toContainText('(dans 10 jours)');

		await page.getByTestId('recherche').fill('eleonore');
		await expect(page.getByTestId('proprietaire')).toHaveCount(1);
		await page.getByTestId('recherche').fill('');
		await expect(page.getByTestId('proprietaire')).toHaveCount(2);

		await page.getByRole('link', { name: 'Éléonore Kaboré' }).first().click();
		await expect(page).toHaveURL(`/app/proprietaires/${ownerId}`);
		await expect(page.getByTestId('alerte-fin')).toContainText('Ce mandat se termine dans 10 jours');
		await expect(page.getByRole('button', { name: 'Modifier' })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Révoquer' })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Nouveau mandat' })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Historique' })).toBeVisible();
	});

	test('bailleur particulier : ni propriétaires ni mandats dans sa navigation, ni à l’écran', async ({ page, request }) => {
		const who = await registerViaApi(request, 'Bailleur autonome');
		const token = await login(request, who.phone, who.password);
		const created = await request.post(`${API_URL}/organizations`, {
			headers: { Authorization: `Bearer ${token}` },
			data: { id: newId(), type: 'landlord', legalName: 'Bailleur autonome', phone: '+22670900003', commune: 'Saaba' }
		});
		expect(created.status()).toBe(201);
		await signInWith(page, who, '/app');
		await expect(page).toHaveURL('/app');
		await synced(page);
		// La navigation est affichée (sinon « aucune entrée » serait vrai d'une page vide) ; elle n'a pas « Propriétaires ».
		const nav = page.getByRole('navigation', { name: 'Navigation principale' });
		await expect(nav.getByRole('link', { name: 'Mes logements' }).first()).toBeVisible();
		await expect(nav.getByRole('link', { name: 'Propriétaires' })).toHaveCount(0);
		await page.goto('/app/proprietaires');
		await expect(page.getByText('Vous gérez vous-même vos logements : aucun propriétaire ni mandat à gérer ici.')).toBeVisible();
	});
});

test.describe('Écrans des propriétaires sur les trois appareils', () => {
	test('liste, création et fiche : sans débordement sur téléphone, tablette et ordinateur', async ({ page, request }) => {
		const agency = await freshAgency(request, `Agence écrans ${newId().slice(-6)}`);
		const { ownerId } = await ownerWithMandate(
			request,
			agency,
			'Propriétaire au nom très long pour vérifier le retour à la ligne',
			addDays(today, 5)
		);
		await signInWith(page, agency.director, '/app/proprietaires');
		await synced(page);
		for (const [label, name, viewport] of [
			['téléphone', 'telephone', { width: 360, height: 800 }],
			['tablette', 'tablette', { width: 820, height: 1180 }],
			['ordinateur', 'ordinateur', { width: 1440, height: 900 }]
		] as const) {
			await page.setViewportSize(viewport);
			await page.goto('/app/proprietaires');
			await shell(page, name);
			await expect(page.getByTestId('proprietaire')).toHaveCount(1);
			await expectNoHorizontalOverflow(page, `Propriétaires, ${label}`);
			await page.goto('/app/proprietaires/nouveau');
			await shell(page, name);
			await page.getByLabel('Type de propriétaire').selectOption('group');
			await expect(page.getByLabel('Nom du représentant')).toBeVisible();
			await expectNoHorizontalOverflow(page, `Nouveau propriétaire, ${label}`);
			await page.goto(`/app/proprietaires/${ownerId}`);
			await shell(page, name);
			await expect(page.getByTestId('mandat')).toBeVisible();
			await expectNoHorizontalOverflow(page, `Fiche propriétaire, ${label}`);
		}
	});
});
