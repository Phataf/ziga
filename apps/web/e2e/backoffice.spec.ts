/**
 * Lot 04 : back-office des interrupteurs et réglages de l'organisation.
 * - Critère d'acceptation : en moins d'une minute, couper `listings.publication` pour tous, l'ouvrir pour une seule
 *   agence, puis la fermer pour une seule personne de cette agence ; chaque état vérifié par le simulateur (étape et
 *   motif) et par un appel d'API (`GET /me/features`).
 * - Moyens de paiement acceptés (D18) : un réglage de l'organisation, au moins un reste coché.
 * - Écrans du back-office sur téléphone, tablette et ordinateur, sans débordement horizontal.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { accounts, API_URL, expectNoHorizontalOverflow, ORG_A, ORG_B, signIn, type Account } from './support';

const phone = { viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true };
const tablet = { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true };
const desktop = { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false };

const KEY = 'listings.publication';
const ADMIN_SCREENS = [
	'/admin',
	'/admin/personnes',
	'/admin/formules',
	'/admin/fonctionnalites',
	`/admin/fonctionnalites/${KEY}`,
	'/admin/fonctionnalites/simulateur',
	'/admin/journal',
	'/admin/assistance'
];

async function token(request: APIRequestContext, account: Account): Promise<string> {
	const a = accounts[account];
	const res = await request.post(`${API_URL}/auth/login`, { data: { phone: a.phone, password: a.password } });
	expect(res.status()).toBe(200);
	return ((await res.json()) as { accessToken: string }).accessToken;
}

async function organizationId(request: APIRequestContext, bearer: string, name: string): Promise<string> {
	const res = await request.get(`${API_URL}/me/organizations`, { headers: { Authorization: `Bearer ${bearer}` } });
	const list = (await res.json()) as { organizationId: string; name: string }[];
	return list.find((o) => o.name === name)!.organizationId;
}

/** État effectif vu par l'API pour cette personne, dans cette organisation. */
async function apiEnabled(request: APIRequestContext, bearer: string, orgId: string): Promise<boolean> {
	const res = await request.get(`${API_URL}/me/features`, { headers: { Authorization: `Bearer ${bearer}`, 'X-Organization-Id': orgId } });
	expect(res.status()).toBe(200);
	const body = (await res.json()) as { features: Record<string, { enabled: boolean }> };
	return body.features[KEY]!.enabled;
}

/** Simulateur : organisation et personne choisies par l'écran ; renvoie le motif affiché pour la clé. */
async function simulate(page: Page, org: string, person: { name: string; national: string } | null): Promise<string> {
	await page.goto('/admin/fonctionnalites/simulateur');
	await page.getByTestId('simulateur-organisation').selectOption({ label: org });
	if (person) {
		// Recherche par numéro : unique, alors que deux personnes peuvent porter le même nom.
		await page.locator('#simulateur-recherche').fill(person.national.replace(/\s/g, ''));
		await page.getByRole('button', { name: 'Rechercher' }).click();
		const select = page.getByTestId('simulateur-personne');
		await expect(select.locator('option')).toHaveCount(2);
		await expect(select.locator('option').nth(1)).toContainText(person.name);
		await select.selectOption({ index: 1 });
	}
	await page.getByRole('button', { name: 'Simuler' }).click();
	const row = page.getByTestId('resultat-simulateur').locator(`[data-cle="${KEY}"]`);
	await expect(row).toBeVisible();
	return (await row.innerText()).replace(/\s+/g, ' ');
}

async function setMode(page: Page, label: string, reason: string): Promise<void> {
	await page.goto('/admin/fonctionnalites');
	const row = page.locator(`[data-testid="interrupteur"][data-cle="${KEY}"]`);
	await row.getByRole('button', { name: label }).click();
	await expect(page.getByTestId('impact')).toContainText('organisation');
	await page.getByTestId('motif-interrupteur').fill(reason);
	await page.getByRole('button', { name: 'Confirmer' }).click();
	await expect(row.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'true');
}

async function addOverride(
	page: Page,
	scope: 'organisation' | 'personne',
	target: string,
	value: 'Forcer à oui' | 'Forcer à non',
	reason: string
) {
	await page.goto(`/admin/fonctionnalites/${KEY}`);
	const form = page.getByRole('form', { name: 'Ajouter une exception' });
	if (scope === 'organisation') {
		await form.getByTestId('cible-organisation').selectOption({ label: target });
	} else {
		await form.getByLabel('Portée').selectOption({ label: 'Personne' });
		await form.locator('#recherche-personne').fill(target);
		await form.getByRole('button', { name: 'Rechercher' }).click();
		await expect(form.getByTestId('cible-personne').locator('option')).toHaveCount(2);
		await form.getByTestId('cible-personne').selectOption({ index: 1 });
	}
	await form.getByLabel(value).check();
	await form.getByTestId('motif-exception').fill(reason);
	await form.getByRole('button', { name: 'Ajouter une exception' }).click();
	await expect(page.getByTestId('exception').filter({ hasText: reason })).toBeVisible();
}

test.describe('Ordinateur (1440 × 900)', () => {
	test.use(desktop);

	test('couper pour tous, ouvrir pour une agence, fermer pour une personne : en moins d’une minute', async ({ page, request }) => {
		const director = await token(request, 'director');
		const manager = await token(request, 'managerAndLandlord');
		const directorB = await token(request, 'directorB');
		const orgA = await organizationId(request, director, ORG_A);
		const orgB = await organizationId(request, directorB, ORG_B);
		const admin = await token(request, 'admin');
		try {
			await signIn(page, 'admin', '/admin/fonctionnalites');
			const started = Date.now();

			// 1. Coupée pour tous : étape 1, partout.
			await setMode(page, 'Coupée pour tous', 'Test e2e : coupure générale');
			expect(await simulate(page, ORG_A, accounts.director)).toContain('Non — coupée pour tous');
			expect(await apiEnabled(request, director, orgA)).toBe(false);
			expect(await apiEnabled(request, directorB, orgB)).toBe(false);

			// 2. Ouverte sur liste, avec une exception pour l'agence A seulement.
			await setMode(page, 'Ouverte sur liste', 'Test e2e : ouverture sur liste');
			await addOverride(page, 'organisation', ORG_A, 'Forcer à oui', 'Test e2e : agence pilote');
			expect(await simulate(page, ORG_A, accounts.director)).toContain('Oui — exception pour l’organisation');
			expect(await simulate(page, ORG_B, accounts.directorB)).toContain('Non — ouverte sur liste');
			expect(await apiEnabled(request, director, orgA)).toBe(true);
			expect(await apiEnabled(request, directorB, orgB)).toBe(false);

			// 3. Fermée pour une seule personne de l'agence A.
			await addOverride(
				page,
				'personne',
				accounts.managerAndLandlord.national.replace(/\s/g, ''),
				'Forcer à non',
				'Test e2e : une personne'
			);
			expect(await simulate(page, ORG_A, accounts.managerAndLandlord)).toContain('Non — exception pour cette personne');
			expect(await simulate(page, ORG_A, accounts.director)).toContain('Oui — exception pour l’organisation');
			expect(await apiEnabled(request, manager, orgA)).toBe(false);
			expect(await apiEnabled(request, director, orgA)).toBe(true);

			expect(Date.now() - started).toBeLessThan(60_000);

			// Chaque changement est au journal du back-office.
			await page.goto('/admin/journal');
			await page.getByTestId('filtre-action').selectOption({ label: 'Interrupteurs' });
			await expect(page.getByTestId('evenement').filter({ hasText: 'Exception posée' }).first()).toBeVisible();
			await expect(page.getByTestId('evenement').filter({ hasText: 'Mode global modifié' }).first()).toBeVisible();
		} finally {
			// Remise en état pour les autres tests : exceptions révoquées, ouverte à tous.
			const headers = { Authorization: `Bearer ${admin}` };
			const detail = (await (await request.get(`${API_URL}/admin/features/${KEY}`, { headers })).json()) as { overrides: { id: string }[] };
			for (const o of detail.overrides) {
				await request.delete(`${API_URL}/admin/overrides/${o.id}`, { headers, data: { reason: 'Fin du test e2e' } });
			}
			await request.put(`${API_URL}/admin/features/${KEY}/mode`, { headers, data: { mode: 'enabled', reason: 'Fin du test e2e' } });
		}
	});

	test('un rôle commercial lit les interrupteurs sans pouvoir les modifier', async ({ page }) => {
		await signIn(page, 'sales', '/admin/fonctionnalites');
		await expect(page.getByText('Lecture seule : seul l’administrateur général modifie les interrupteurs.')).toBeVisible();
		const row = page.locator(`[data-testid="interrupteur"][data-cle="${KEY}"]`);
		await expect(row.getByRole('button', { name: 'Coupée pour tous' })).toBeDisabled();
		// L'assistance n'est pas dans son menu.
		await expect(page.getByTestId('menu-lateral').getByRole('link', { name: 'Accès d’assistance' })).toHaveCount(0);
	});

	test('moyens de paiement : un réglage de l’organisation, au moins un reste coché', async ({ page }) => {
		await signIn(page, 'directorB', '/espace');
		await page.goto('/espace');
		await page.getByTestId('espace-organisation').filter({ hasText: ORG_B }).click();
		await page.goto('/app/organisation');
		const section = page.getByTestId('moyens-paiement');
		const transfer = section.getByLabel('Virement bancaire');
		const cash = section.getByLabel('Espèces');
		const momo = section.getByLabel('Mobile Money (saisi avec sa référence)');
		for (const box of [transfer, momo]) if (await box.isChecked()) await box.uncheck();
		await expect(cash).toBeChecked();
		// Le dernier moyen coché ne peut pas être décoché.
		await expect(cash).toBeDisabled();
		await transfer.check();
		await expect(section.getByText('Moyens de paiement enregistrés.')).toBeVisible();
		await expect(cash).toBeEnabled();
		await page.reload();
		await expect(page.getByTestId('moyens-paiement').getByLabel('Virement bancaire')).toBeChecked();
	});

	test('écrans du back-office sans débordement', async ({ page }) => {
		await signIn(page, 'admin', '/admin');
		for (const path of ADMIN_SCREENS) {
			await page.goto(path);
			await expect(page.locator('h1').first()).toBeVisible();
			await expectNoHorizontalOverflow(page, path);
		}
	});
});

for (const [label, size] of [
	['Téléphone (360 × 800)', phone],
	['Tablette (820 × 1180)', tablet]
] as const) {
	test.describe(label, () => {
		test.use(size);
		test('écrans du back-office sans débordement', async ({ page }) => {
			await signIn(page, 'admin', '/admin');
			for (const path of ADMIN_SCREENS) {
				await page.goto(path);
				await expect(page.locator('h1').first()).toBeVisible();
				await expectNoHorizontalOverflow(page, path);
			}
		});
	});
}
