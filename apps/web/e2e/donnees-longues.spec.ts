/**
 * Données longues sur tablette (820 × 1180), sans débordement horizontal de la page : nom de 40 caractères, téléphone
 * complet (ses groupes ne se coupent plus, règle 2), montant à 9 chiffres. Tableaux et cartes qui affichent des
 * téléphones ou des montants : personnes, abonnements et organisations (back-office), équipe, locataires, fiche
 * locataire, fiche bail, contrats.
 *
 * Origine : /admin/personnes débordait de 10 px selon les personnes inscrites par les autres tests. Le tableau, plus
 * large que son cadre, y défilait seul, mais l'en-tête invisible de sa dernière colonne (position absolue) échappait au
 * cadre et élargissait la page.
 */
import { expect, test, type Page } from '@playwright/test';
import { addDays, toIsoDate } from '@ziga/shared/dates';
import { newId } from '@ziga/shared/ids';
import { formatPhone } from '@ziga/shared/phone';
import { addMember, freshAgency, login, post } from './agency';
import { accounts, API_URL, expectNoHorizontalOverflow, registerViaApi, signIn, signInWith, synced } from './support';

test.use({ viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true });

/** 40 caractères, avec des traits d'union : seuls les espaces permettent de couper. */
const LONG_NAME = 'Marie-Clémentine Ouédraogo-Kaboré Sanogo';
/** Montant à 9 chiffres : « 999 999 999 FCFA ». */
const BIG = 999_999_999;
const today = toIsoDate();

/**
 * Sur tablette, un tableau est simplifié (docs/UX.md §3) : il tient dans son cadre, sans défilement horizontal. Plus
 * strict que l'absence de débordement de la page, et indépendant des données laissées par les autres tests.
 */
async function expectTablesFit(page: Page, label: string): Promise<void> {
	const wide = await page.evaluate(() =>
		[...document.querySelectorAll('table')]
			.filter((t) => t.scrollWidth > (t.parentElement?.clientWidth ?? Infinity) + 0.5)
			.map(
				(t) =>
					`${(t.querySelector('thead')?.textContent ?? '').trim().slice(0, 60)} : ${t.scrollWidth} px pour ${t.parentElement?.clientWidth} px`
			)
	);
	expect(wide, `${label} : tableau plus large que son cadre`).toEqual([]);
}

async function expectFits(page: Page, label: string): Promise<void> {
	await expectNoHorizontalOverflow(page, label);
	await expectTablesFit(page, label);
}

test('le nom de test fait bien 40 caractères', () => {
	expect(LONG_NAME).toHaveLength(40);
});

test('back-office : personnes, abonnements et organisations, avec des données longues', async ({ page, request }) => {
	test.setTimeout(2 * 60_000);
	const person = await registerViaApi(request, LONG_NAME);
	const agency = await freshAgency(request, `${LONG_NAME.slice(0, 30)} ${newId().slice(-6)}`);
	const admin = await login(request, accounts.admin.phone, accounts.admin.password);
	const sub = await request.post(`${API_URL}/admin/subscriptions`, {
		headers: { Authorization: `Bearer ${admin}` },
		data: { organizationId: agency.id, planId: 'pro', startsOn: today, endsOn: addDays(today, 365), amount: BIG, paymentStatus: 'pending' }
	});
	expect(sub.status(), await sub.text()).toBe(201);

	// Liste par défaut (les inscriptions les plus récentes, dont la nôtre), celle qui débordait en CI.
	await signIn(page, 'admin', '/admin/personnes');
	await expect(page.getByTestId('personne').filter({ hasText: formatPhone(person.phone) })).toHaveCount(1);
	await expectFits(page, '/admin/personnes, liste par défaut');
	await page.getByLabel('Nom ou numéro').fill(LONG_NAME);
	await page.getByRole('button', { name: 'Rechercher' }).click();
	// Le test de l'agence, en parallèle, inscrit une autre personne au même nom : on retrouve la nôtre par son numéro.
	await expect(
		page
			.getByTestId('personne')
			.filter({ hasText: LONG_NAME })
			.filter({ hasText: formatPhone(person.phone) })
	).toHaveCount(1);
	await expectFits(page, '/admin/personnes, nom de 40 caractères');

	await page.goto('/admin/formules');
	await expect(page.getByTestId('abonnement').filter({ hasText: '999' }).first()).toContainText('999 999 999 FCFA');
	await expectFits(page, '/admin/formules, montant à 9 chiffres');

	await page.goto('/admin');
	await expect(page.locator('h1').first()).toBeVisible();
	await expectFits(page, '/admin, organisation au nom long');
});

test('agence : équipe, locataires, fiche locataire, fiche bail et contrats, avec des données longues', async ({ page, request }) => {
	test.setTimeout(3 * 60_000);
	const agency = await freshAgency(request, `Agence données longues ${newId().slice(-6)}`);
	await addMember(request, agency, 'manager', LONG_NAME);

	// Unité couverte par un mandat, locataire au nom long, bail à 999 999 999 FCFA par mois.
	const ownerId = newId();
	await post(request, agency.headers, '/owners', { id: ownerId, type: 'person', name: LONG_NAME, phone: '+22670900004' });
	const admin = await login(request, accounts.admin.phone, accounts.admin.password);
	const geo = (await (await request.get(`${API_URL}/admin/geography`, { headers: { Authorization: `Bearer ${admin}` } })).json()) as {
		neighborhoods: { id: string; name: string }[];
	};
	const propertyId = newId();
	await post(request, agency.headers, '/properties', {
		id: propertyId,
		ownerId,
		type: 'apartment_building',
		name: `Résidence ${LONG_NAME}`,
		communeId: 'ouagadougou',
		neighborhoodId: geo.neighborhoods.find((n) => n.name === 'Tampouy')!.id
	});
	const unitId = newId();
	await post(request, agency.headers, '/units', { id: unitId, propertyId, type: 'apartment', label: 'Appartement A12', rent: BIG });
	await post(request, agency.headers, `/properties/${propertyId}/status`, { status: 'active' });
	await post(request, agency.headers, `/units/${unitId}/status`, { status: 'active' });
	const mandateId = newId();
	await post(request, agency.headers, '/mandates', {
		id: mandateId,
		ownerId,
		type: 'rental_management',
		startsOn: addDays(today, -30),
		commission: { basis: 'percent_of_collected', rateBp: 1000 }
	});
	await post(request, agency.headers, `/mandates/${mandateId}/scopes`, { id: newId(), propertyId });
	const tenantId = newId();
	await post(request, agency.headers, '/tenants', { id: tenantId, fullName: LONG_NAME, phone: '+22670445599' });
	const leaseId = newId();
	await post(request, agency.headers, '/leases', {
		id: leaseId,
		unitId,
		tenantId,
		startsOn: today,
		durationMonths: 12,
		rent: BIG,
		charges: BIG,
		lessorType: 'owner'
	});
	await post(request, agency.headers, '/deposit-accounts', {
		id: newId(),
		leaseId,
		type: 'security_deposit',
		agreedAmount: BIG,
		holder: 'organization'
	});

	await signInWith(page, agency.director, '/app/equipe');
	await synced(page);
	await expect(page.getByTestId('membre').filter({ hasText: LONG_NAME })).toHaveCount(1);
	await expectFits(page, '/app/equipe, nom long et téléphone complet');

	for (const [path, ready] of [
		['/app/locataires', 'locataire'],
		[`/app/locataires/${tenantId}`, null],
		[`/app/baux/${leaseId}`, 'echeance'],
		['/app/contrats', 'ligne-contrat']
	] as const) {
		await page.goto(path);
		await synced(page);
		if (ready) await expect(page.getByTestId(ready).first()).toBeVisible();
		else await expect(page.locator('h1').first()).toContainText(LONG_NAME);
		await expectFits(page, `${path}, nom de 40 caractères et montant à 9 chiffres`);
	}
	await expect(page.getByTestId('ligne-contrat').first()).toContainText(LONG_NAME);
});
