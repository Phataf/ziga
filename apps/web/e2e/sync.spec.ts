/**
 * Lot 05, étape 2 : lecture synchronisée, contre le vrai service PowerSync (scripts/e2e-powersync.mjs).
 * - Une personne de A ne reçoit aucune ligne de B : flux lu directement auprès du service, avec le jeton de l'API.
 * - Membre retiré, organisation suspendue : plus rien à la synchronisation suivante, et la base locale se vide.
 * - Délai de synchronisation inférieur à 5 secondes ; écrans ouverts sans appel réseau, même hors ligne.
 * - Déconnexion : base locale vide.
 * Étapes 3 et 4 : écriture hors ligne, puis refus (« Modifications non acceptées », valeur du serveur revenue).
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { newId } from '@ziga/shared/ids';
import { formatPhone } from '@ziga/shared/phone';
import { accounts, API_URL, expectNoHorizontalOverflow, registerViaApi, signInWith, synced, type Account } from './support';

test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

type Row = { table: string; data: Record<string, unknown> };

async function login(request: APIRequestContext, phone: string, password: string): Promise<string> {
	const r = await request.post(`${API_URL}/auth/login`, { data: { phone, password } });
	expect(r.status()).toBe(200);
	return ((await r.json()) as { accessToken: string }).accessToken;
}

const loginAs = (request: APIRequestContext, a: Account) => login(request, accounts[a].phone, accounts[a].password);

/**
 * Ce que le service PowerSync envoie à cette personne, jusqu'au premier point de contrôle complet : jeton demandé à
 * l'API (GET /sync/credentials), puis flux du service. Les lignes supprimées n'y figurent pas.
 */
async function received(request: APIRequestContext, accessToken: string): Promise<Row[]> {
	const cred = await request.get(`${API_URL}/sync/credentials`, { headers: { Authorization: `Bearer ${accessToken}` } });
	expect(cred.status()).toBe(200);
	const { endpoint, token } = (await cred.json()) as { endpoint: string; token: string };
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);
	const res = await fetch(`${endpoint}/sync/stream`, {
		method: 'POST',
		signal: controller.signal,
		headers: { authorization: `Token ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify({
			buckets: [],
			include_checksum: true,
			raw_data: true,
			client_id: `e2e-${newId()}`,
			streams: { include_defaults: true, subscriptions: [] }
		})
	});
	expect(res.status).toBe(200);
	const rows = new Map<string, Row>();
	let buffer = '';
	try {
		for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
			buffer += Buffer.from(chunk).toString();
			let nl: number;
			let done = false;
			while ((nl = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (!line) continue;
				const message = JSON.parse(line) as {
					data?: { data: { op: string; object_type: string; object_id: string; data?: string }[] };
					checkpoint_complete?: unknown;
				};
				for (const op of message.data?.data ?? []) {
					const key = `${op.object_type}/${op.object_id}`;
					if (op.op === 'PUT' && op.data) rows.set(key, { table: op.object_type, data: JSON.parse(op.data) });
					else rows.delete(key);
				}
				if (message.checkpoint_complete) done = true;
			}
			if (done) break;
		}
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
	return [...rows.values()];
}

const organizationsIn = (rows: Row[]) =>
	rows.filter((r) => r.table === 'organizations').map((r) => String(r.data.trade_name ?? r.data.legal_name));

/** Nombre de lignes par table de la base locale du navigateur (accès de test, PUBLIC_E2E=1 seulement). */
function localCounts(page: Page): Promise<Record<string, number>> {
	return page.evaluate(() => (window as unknown as { __zigaLocalCounts: () => Promise<Record<string, number>> }).__zigaLocalCounts());
}

/** Agence neuve : sa directrice (compte et jeton) ; propre au test, pour ne gêner aucun autre test en parallèle. */
async function freshAgency(request: APIRequestContext, name: string) {
	const director = await registerViaApi(request, `Directrice ${name}`);
	const token = await login(request, director.phone, director.password);
	const id = newId();
	const created = await request.post(`${API_URL}/organizations`, {
		headers: { Authorization: `Bearer ${token}` },
		data: { id, type: 'agency', legalName: name, phone: '+22625300000', commune: 'Ouagadougou' }
	});
	expect(created.status()).toBe(201);
	return { id, director, token, headers: { Authorization: `Bearer ${token}`, 'X-Organization-Id': id } };
}

test.describe('Synchronisation : ce que reçoit chaque personne (service PowerSync)', () => {
	test('une personne de A ne reçoit aucune ligne de B, et inversement', async ({ request }) => {
		const a = await received(request, await loginAs(request, 'director'));
		const b = await received(request, await loginAs(request, 'directorB'));
		expect(organizationsIn(a)).toEqual(['Faso Immobilier']);
		expect(organizationsIn(b)).toEqual(['Sahel Habitat']);
		const orgA = a.find((r) => r.table === 'organizations')!.data;
		const orgB = b.find((r) => r.table === 'organizations')!.data;
		// Aucune ligne d'organisation (membres, réglages, exceptions) qui ne soit pas la sienne.
		for (const r of a) if ('organization_id' in r.data && r.data.organization_id) expect(r.data.organization_id).toBe(orgA.id);
		for (const r of b) if ('organization_id' in r.data && r.data.organization_id) expect(r.data.organization_id).toBe(orgB.id);
		// Équipe sans données sensibles : ni téléphone ni mot de passe.
		for (const r of [...a, ...b].filter((r) => r.table === 'organization_members')) {
			expect(Object.keys(r.data).sort()).toEqual(['display_name', 'id', 'joined_at', 'organization_id', 'role', 'status', 'user_id']);
		}
	});

	test('le représentant légal ne descend que chez le directeur', async ({ request }) => {
		const director = await received(request, await loginAs(request, 'director'));
		const viewer = await received(request, await loginAs(request, 'viewer'));
		expect(director.filter((r) => r.table === 'organization_representatives')).toHaveLength(1);
		expect(viewer.filter((r) => r.table === 'organization_representatives')).toHaveLength(0);
		expect(organizationsIn(viewer)).toEqual(['Faso Immobilier']);
	});

	test('organisation suspendue : ses membres ne reçoivent plus rien', async ({ request }) => {
		const agency = await freshAgency(request, `Agence suspendue ${newId().slice(-6)}`);
		// La réplication prend un instant : on attend que la nouvelle agence arrive avant de la suspendre.
		await expect.poll(async () => organizationsIn(await received(request, agency.token)).length, { timeout: 10_000 }).toBe(1);
		const admin = await loginAs(request, 'admin');
		const r = await request.post(`${API_URL}/admin/organizations/${agency.id}/suspend`, {
			headers: { Authorization: `Bearer ${admin}` },
			data: { reason: 'Test de bout en bout : suspension' }
		});
		expect(r.status()).toBe(204);
		// Plus aucune donnée de l'organisation ; seul reste le catalogue des fonctionnalités, commun à tous.
		const ofOrganization = (rows: Row[]) =>
			rows.filter((r) => r.data.id === agency.id || r.data.organization_id === agency.id).map((r) => r.table);
		await expect.poll(async () => ofOrganization(await received(request, agency.token)), { timeout: 10_000 }).toEqual([]);
		const after = await received(request, agency.token);
		expect([...new Set(after.map((r) => r.table))].sort()).toEqual(['features', 'plan_features']);
	});
});

test.describe('Synchronisation : la base locale du navigateur', () => {
	test('membre retiré : ses données locales de l’organisation disparaissent à la synchronisation suivante', async ({ page, request }) => {
		const agency = await freshAgency(request, `Agence retrait ${newId().slice(-6)}`);
		// Formule Pro : la formule Découverte ne permet qu'un utilisateur (lot 04). Gestionnaire : il voit l'équipe.
		const admin = await loginAs(request, 'admin');
		const plan = await request.put(`${API_URL}/admin/organizations/${agency.id}/plan`, {
			headers: { Authorization: `Bearer ${admin}` },
			data: { planId: 'pro', reason: 'Test de bout en bout : deux membres' }
		});
		expect(plan.status()).toBe(204);
		const member = await registerViaApi(request, 'Membre retiré');
		const invitation = await request.post(`${API_URL}/organization/invitations`, {
			headers: agency.headers,
			data: { phone: member.phone, role: 'manager' }
		});
		expect(invitation.status()).toBe(201);
		const memberToken = await login(request, member.phone, member.password);
		const { token } = (await invitation.json()) as { token: string };
		expect(
			(await request.post(`${API_URL}/invitations/${token}/accept`, { headers: { Authorization: `Bearer ${memberToken}` } })).status()
		).toBe(200);

		await signInWith(page, member, '/app/equipe');
		await synced(page);
		await expect(page.getByTestId('membre')).toHaveCount(2);
		const before = await localCounts(page);
		expect(before.organizations).toBe(1);
		expect(before.organization_members).toBe(2);

		const members = (await (await request.get(`${API_URL}/organization/members`, { headers: agency.headers })).json()) as {
			id: string;
			userId: string;
		}[];
		const me = (await (await request.get(`${API_URL}/me`, { headers: { Authorization: `Bearer ${memberToken}` } })).json()) as {
			id: string;
		};
		const membership = members.find((m) => m.userId === me.id)!;
		expect((await request.delete(`${API_URL}/organization/members/${membership.id}`, { headers: agency.headers })).status()).toBe(204);

		await expect.poll(async () => (await localCounts(page)).organizations, { timeout: 10_000 }).toBe(0);
		expect((await localCounts(page)).organization_members).toBe(0);
	});

	test('délai de synchronisation inférieur à 5 secondes, une fois en ligne', async ({ page, request }) => {
		const agency = await freshAgency(request, `Agence délai ${newId().slice(-6)}`);
		await signInWith(page, agency.director, '/app/organisation');
		await synced(page);
		const preview = page.getByTestId('apercu-entete');
		await expect(preview).toContainText('Agence délai');
		const name = `Nom synchronisé ${newId().slice(-6)}`;
		const sent = Date.now();
		const r = await request.patch(`${API_URL}/organization`, {
			headers: agency.headers,
			data: { legalName: name, phone: '+22625300000', commune: 'Ouagadougou', representative: {} }
		});
		expect(r.status()).toBe(200);
		await expect(preview).toContainText(name, { timeout: 5_000 });
		expect(Date.now() - sent).toBeLessThan(5_000);
	});

	test('écrans ouverts sans appel réseau, puis hors ligne ; déconnexion : base locale vide', async ({ page, context, request }) => {
		const agency = await freshAgency(request, `Agence hors ligne ${newId().slice(-6)}`);
		await signInWith(page, agency.director, '/app/equipe');
		await synced(page);
		await expect(page.getByTestId('membre')).toHaveCount(1);

		// En ligne : la fiche et l'équipe s'affichent sans attendre l'API (lecture locale). Seuls les numéros des membres
		// se lisent en ligne : la réponse est retenue, et l'équipe s'affiche quand même.
		const reads: string[] = [];
		page.on('request', (req) => {
			const path = req.url().startsWith(API_URL) ? new URL(req.url()).pathname : null;
			if (path && ['/organization', '/organization/members', '/organization/features'].includes(path))
				reads.push(`${req.method()} ${path}`);
		});
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		await page.route(`${API_URL}/organization/members`, async (route) => {
			await held;
			await route.continue();
		});
		await page
			.getByRole('navigation', { name: 'Navigation principale' })
			.getByRole('link', { name: 'Paramètres de l’organisation' })
			.click();
		await expect(page.getByLabel('Raison sociale')).toHaveValue(/Agence hors ligne/);
		await page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('link', { name: 'Équipe' }).click();
		await expect(page.getByTestId('membre')).toHaveCount(1);
		await expect(page.getByTestId('membre')).toContainText(`Directrice Agence hors ligne`);
		expect(reads).toEqual(['GET /organization/members']);
		// La réponse arrive : le numéro s'ajoute, pour le directeur.
		release();
		await expect(page.getByTestId('telephone-membre')).toHaveText(formatPhone(agency.director.phone));
		await page.unroute(`${API_URL}/organization/members`);

		// Hors ligne, page rechargée : l'équipe et la fiche viennent de l'appareil.
		await context.setOffline(true);
		await page.reload();
		await expect(page.getByTestId('etat-synchro')).toHaveAttribute('data-etat', 'offline');
		await expect(page.getByTestId('etat-synchro')).toHaveText('Hors ligne');
		await expect(page.getByTestId('membre')).toHaveCount(1);
		// Numéros et invitations en attente (lus en ligne) le disent, sans message d'erreur.
		await expect(page.getByTestId('telephone-membre')).toHaveText('Numéro disponible en ligne');
		await expect(page.getByText('Les invitations en attente s’affichent quand la connexion revient.')).toBeVisible();
		await expect(page.getByTestId('erreur-formulaire')).toHaveCount(0);
		await context.setOffline(false);
		await expect(page.getByText('Aucune invitation en attente.')).toBeVisible();
		await synced(page);

		// Déconnexion : plus rien de l'organisation sur l'appareil.
		expect((await localCounts(page)).organizations).toBe(1);
		await page.getByRole('button', { name: 'Se déconnecter' }).click();
		await expect(page).toHaveURL(/\/connexion/);
		await expect.poll(async () => Object.values(await localCounts(page)).reduce((a, b) => a + b, 0), { timeout: 10_000 }).toBe(0);
	});
});

test.describe('Synchronisation : écrire sur l’appareil (étape 3)', () => {
	test('hors ligne, modifier ; revenir en ligne : la modification arrive en base, avec son audit d’origine sync', async ({
		page,
		context,
		request
	}) => {
		const agency = await freshAgency(request, `Agence écriture ${newId().slice(-6)}`);
		await signInWith(page, agency.director, '/app/organisation');
		await synced(page);
		await expect(page.getByLabel('Raison sociale')).toHaveValue(/Agence écriture/);

		await context.setOffline(true);
		await expect(page.getByTestId('etat-synchro')).toHaveAttribute('data-etat', 'offline');
		const name = `Nom hors ligne ${newId().slice(-6)}`;
		await page.getByLabel('Nom commercial').fill(name);
		await page.getByRole('button', { name: 'Enregistrer' }).click();
		await expect(page.getByText('Paramètres enregistrés sur l’appareil : ils partiront dès que la connexion revient.')).toBeVisible();
		// Écrit sur l'appareil, en attente d'envoi ; le serveur n'a encore rien reçu.
		await expect(page.getByTestId('apercu-entete')).toContainText(name);
		expect((await localCounts(page)).ps_crud).toBe(1);
		const server = async () =>
			((await (await request.get(`${API_URL}/organization`, { headers: agency.headers })).json()) as { tradeName: string | null })
				.tradeName;
		expect(await server()).toBeNull();

		await context.setOffline(false);
		await synced(page);
		await expect.poll(server, { timeout: 5_000 }).toBe(name);
		expect((await localCounts(page)).ps_crud).toBe(0);
		const audit = (await (await request.get(`${API_URL}/organization/audit`, { headers: agency.headers })).json()) as {
			entries: { action: string; origin: string; after: Record<string, unknown> | null }[];
		};
		expect(audit.entries.find((e) => e.action === 'organization.update')).toMatchObject({ origin: 'sync', after: { tradeName: name } });
	});

	test('en ligne : l’indicateur montre la modification en attente, puis « À jour »', async ({ page, request }) => {
		const agency = await freshAgency(request, `Agence attente ${newId().slice(-6)}`);
		await signInWith(page, agency.director, '/app/organisation');
		await synced(page);
		// Envoi retenu un instant : l'attente est visible.
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		await page.route(`${API_URL}/sync/upload`, async (route) => {
			await held;
			await route.continue();
		});
		await page.getByLabel('Nom commercial').fill('Nom en attente');
		await page.getByRole('button', { name: 'Enregistrer' }).click();
		await expect(page.getByTestId('etat-synchro')).toHaveText('1 modification en attente');
		release();
		await synced(page);
	});
});

test.describe('Synchronisation : refus et « Modifications non acceptées » (étape 4)', () => {
	test('devenue gestionnaire pendant qu’elle était hors ligne : le nom est refusé, la valeur du serveur revient, le refus est gardé', async ({
		page,
		context,
		request
	}) => {
		const agency = await freshAgency(request, `Agence refus ${newId().slice(-6)}`);
		// Un second directeur (formule Pro : deux membres) changera le rôle de la première pendant qu'elle est hors ligne.
		const admin = await loginAs(request, 'admin');
		const plan = await request.put(`${API_URL}/admin/organizations/${agency.id}/plan`, {
			headers: { Authorization: `Bearer ${admin}` },
			data: { planId: 'pro', reason: 'Test de bout en bout : deux directeurs' }
		});
		expect(plan.status()).toBe(204);
		const second = await registerViaApi(request, 'Second directeur');
		const invitation = await request.post(`${API_URL}/organization/invitations`, {
			headers: agency.headers,
			data: { phone: second.phone, role: 'director' }
		});
		expect(invitation.status()).toBe(201);
		const secondToken = await login(request, second.phone, second.password);
		const { token } = (await invitation.json()) as { token: string };
		expect(
			(await request.post(`${API_URL}/invitations/${token}/accept`, { headers: { Authorization: `Bearer ${secondToken}` } })).status()
		).toBe(200);
		const secondHeaders = { Authorization: `Bearer ${secondToken}`, 'X-Organization-Id': agency.id };

		await signInWith(page, agency.director, '/app/organisation');
		await synced(page);
		const preview = page.getByTestId('apercu-entete');
		await expect(preview).toContainText('Agence refus');

		await context.setOffline(true);
		await expect(page.getByTestId('etat-synchro')).toHaveAttribute('data-etat', 'offline');
		const name = `Nom refusé ${newId().slice(-6)}`;
		await page.getByLabel('Nom commercial').fill(name);
		await page.getByRole('button', { name: 'Enregistrer' }).click();
		await expect(page.getByText('Paramètres enregistrés sur l’appareil : ils partiront dès que la connexion revient.')).toBeVisible();
		await expect(preview).toContainText(name);

		// Pendant ce temps, l'autre directeur la fait gestionnaire : elle n'a plus le droit de changer le nom.
		const me = (await (await request.get(`${API_URL}/me`, { headers: agency.headers })).json()) as { id: string };
		const members = (await (await request.get(`${API_URL}/organization/members`, { headers: secondHeaders })).json()) as {
			id: string;
			userId: string;
		}[];
		const membership = members.find((m) => m.userId === me.id)!;
		expect(
			(
				await request.patch(`${API_URL}/organization/members/${membership.id}`, { headers: secondHeaders, data: { role: 'manager' } })
			).status()
		).toBe(200);

		// Reconnexion : refus notifié avec son motif, file vidée, valeur du serveur revenue sur l'appareil.
		await context.setOffline(false);
		const notice = page.getByTestId('refus-notification');
		await expect(notice).toContainText('Une modification n’a pas été acceptée : Votre rôle ne permet pas cette action.', {
			timeout: 15_000
		});
		await synced(page);
		expect((await localCounts(page)).ps_crud).toBe(0);
		await expect(preview).not.toContainText(name);
		await expect(page.getByLabel('Nom commercial')).toHaveValue('');
		await expect(page.getByText('Paramètres enregistrés sur l’appareil : ils partiront dès que la connexion revient.')).toHaveCount(0);
		const server = (await (await request.get(`${API_URL}/organization`, { headers: secondHeaders })).json()) as {
			tradeName: string | null;
		};
		expect(server.tradeName).toBeNull();

		// Rien n'est perdu en silence : la modification est dans la liste, avec ce qui avait été saisi et le motif.
		await notice.getByRole('link', { name: 'Voir les modifications non acceptées' }).click();
		await expect(page).toHaveURL('/app/modifications-non-acceptees');
		await expect(page.getByTestId('refus-notification')).toHaveCount(0);
		const entry = page.getByTestId('refus');
		await expect(entry).toHaveCount(1);
		await expect(entry).toHaveAttribute('data-code', 'FORBIDDEN_ACTION');
		await expect(entry).toContainText('Paramètres de l’organisation');
		await expect(entry).toContainText(`Nom commercial : ${name}`);
		await expect(entry).toContainText('Votre rôle ne permet pas cette action.');
		for (const [label, shell, viewport] of [
			['téléphone', 'telephone', { width: 360, height: 800 }],
			['tablette', 'tablette', { width: 820, height: 1180 }],
			['ordinateur', 'ordinateur', { width: 1440, height: 900 }]
		] as const) {
			await page.setViewportSize(viewport);
			// La coque de l'appareil est rendue avant de mesurer (une seule à la fois, docs/UX.md §3).
			await expect(page.locator(`[data-coque="${shell}"]`)).toBeVisible();
			await expect(page.getByTestId('refus')).toHaveCount(1);
			await expect(page.getByTestId('refus')).toContainText(`Nom commercial : ${name}`);
			await expectNoHorizontalOverflow(page, `Modifications non acceptées, ${label}`);
		}

		// Gardée sur l'appareil (table locale) d'un écran à l'autre, et signalée dans l'en-tête tant qu'elle y est.
		await page.goto('/app/organisation');
		await expect(page.getByTestId('refus-lien')).toHaveText('1 modification non acceptée');
		expect((await localCounts(page)).sync_rejections).toBe(1);
		// Vidée avec le reste de la base à la déconnexion.
		await page.goto('/app/equipe');
		await page.getByRole('button', { name: 'Se déconnecter' }).click();
		await expect(page).toHaveURL(/\/connexion/);
		await expect.poll(async () => (await localCounts(page)).sync_rejections, { timeout: 10_000 }).toBe(0);
	});
});
