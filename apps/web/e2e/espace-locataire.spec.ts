/**
 * Lot 10 ter, étape 3c : espace du locataire, sur les trois appareils (docs/UX.md §8), sans débordement sur téléphone.
 * Une personne, locataire successivement de deux agences (fiches liées par le vrai parcours : invitation SMS, code) :
 * - Agence A : bail de trois mois, congé, fin par la vraie tâche du jour, décompte proposé (toute la caution restituée).
 * - Agence B : bail en cours depuis ce mois, loyer payé.
 * Elle voit son logement actuel (B) avec « Payer par Mobile Money » désactivé et expliqué ; ses contrats en vigueur et
 * terminé ; un historique unique des deux agences ; le reçu de l'ancienne agence, téléchargé depuis son téléphone ; son
 * décompte, qu'elle conteste avec une observation ; un signalement et une demande de préavis transmis à l'organisation.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test, type APIRequestContext, type BrowserContextOptions } from '@playwright/test';
import { addDays, addMonths, monthDay, toIsoDate } from '@ziga/shared/dates';
import { newId } from '@ziga/shared/ids';
import { formatFcfa } from '@ziga/shared/money';
import { newReceiptToken, provisionalReceiptNumber } from '@ziga/shared/payments';
import { DIRECT_PAYMENT_DISABLED_REASON } from '@ziga/shared/portals';
import { availableUnit, freshAgency, get, post, type Agency, type Person } from './agency';
import { linkRecord } from './portals';
import { expectNoHorizontalOverflow, registerViaApi, signInWith } from './support';

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
const DAILY = resolve(import.meta.dirname, '../../api/scripts/e2e-leases-daily.mjs');

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
	return receiptId;
}

type Dues = { status: string; rentDues: { periodStart: string; amountDue: number; amountPaid: number; status: string }[] };
const owed = (l: Dues, before?: string) =>
	l.rentDues
		.filter((d) => d.status !== 'waived' && (!before || d.periodStart < before))
		.reduce((s, d) => s + d.amountDue - d.amountPaid, 0);

async function tenantRecord(request: APIRequestContext, agency: Agency, person: Person, unitId: string, startsOn: string) {
	const tenantId = newId();
	await post(request, agency.headers, '/tenants', { id: tenantId, fullName: 'Salif Traoré', phone: person.phone });
	const leaseId = newId();
	await post(request, agency.headers, '/leases', {
		id: leaseId,
		unitId,
		tenantId,
		startsOn,
		rent: 75000,
		charges: 5000,
		lessorType: 'owner'
	});
	return { tenantId, leaseId };
}

/** Agence A : bail de trois mois, caution reçue, congé, fin par la tâche du jour, décompte proposé ; un reçu avec son PDF. */
async function formerAgency(request: APIRequestContext, person: Person, name: string) {
	const agency = await freshAgency(request, name);
	const { unitId } = await availableUnit(request, agency);
	const { tenantId, leaseId } = await tenantRecord(request, agency, person, unitId, monthDay(ty, tm, -3, 1));
	const accountId = newId();
	await post(request, agency.headers, '/deposit-accounts', {
		id: accountId,
		leaseId,
		type: 'security_deposit',
		agreedAmount: 100000,
		holder: 'organization'
	});
	await pay(request, agency, leaseId, 100000, { purpose: 'deposit', depositAccountId: accountId });
	const before = owed(await get<Dues>(request, agency.headers, `/leases/${leaseId}`), monthDay(ty, tm, 0, 1));
	const receiptId = await pay(request, agency, leaseId, before);
	await post(request, agency.headers, `/leases/${leaseId}/notice`, {
		id: newId(),
		origin: 'tenant',
		deliveryMode: 'hand_delivery',
		notifiedOn: addDays(addMonths(today, -3), 1),
		plannedExitOn: today
	});
	execFileSync(process.execPath, [DAILY, today], { encoding: 'utf8', cwd: resolve(import.meta.dirname, '../../api') });
	const ended = await get<Dues>(request, agency.headers, `/leases/${leaseId}`);
	expect(ended.status).toBe('ended');
	if (owed(ended) > 0) await pay(request, agency, leaseId, owed(ended));
	const settlement = (await post(request, agency.headers, `/deposit-accounts/${accountId}/settlement`, {})) as { id: string };
	await post(request, agency.headers, `/deposit-settlements/${settlement.id}/propose`, {});
	// Le PDF du reçu est produit par le worker : prêt avant la première lecture de l'espace (cache de 30 secondes).
	await expect
		.poll(async () => (await request.get(`http://localhost:3100/receipts/${receiptId}/pdf`, { headers: agency.headers })).status(), {
			timeout: 30_000
		})
		.toBe(200);
	return { agency, tenantId };
}

/** Agence B : bail en cours depuis le premier du mois, loyer du mois payé. */
async function currentAgency(request: APIRequestContext, person: Person, name: string) {
	const agency = await freshAgency(request, name);
	const { unitId } = await availableUnit(request, agency);
	const { tenantId, leaseId } = await tenantRecord(request, agency, person, unitId, monthDay(ty, tm, 0, 1));
	await pay(request, agency, leaseId, 80000);
	return { agency, tenantId, leaseId };
}

test.describe('Espace du locataire (lot 10 ter, étape 3c)', () => {
	for (const [label, options] of devices) {
		test(`${label} : logement, contrats, historique des deux agences, reçu de l’ancienne, décompte contesté, signalement, préavis`, async ({
			browser,
			request
		}) => {
			test.setTimeout(4 * 60_000);
			const suffix = newId().slice(-6);
			const person = await registerViaApi(request, 'Salif Traoré');
			const a = await formerAgency(request, person, `Agence Wend-Panga ${suffix}`);
			await linkRecord(request, a.agency, person, 'tenant', a.tenantId);
			const b = await currentAgency(request, person, `Agence Nong-Taaba ${suffix}`);
			await linkRecord(request, b.agency, person, 'tenant', b.tenantId);
			const nameA = `Agence Wend-Panga ${suffix}`;
			const nameB = `Agence Nong-Taaba ${suffix}`;

			const ctx = await browser.newContext({ ...options, locale: 'fr-FR', timezoneId: 'Africa/Ouagadougou' });
			const page = await ctx.newPage();
			await signInWith(page, person, '/espace/locataire');
			await expect(page).toHaveURL('/espace/locataire');

			// 1. Logement actuel (B) : Mobile Money désactivé, avec l'explication.
			const home = page.getByTestId('logement-actuel');
			await expect(home).toHaveCount(1, { timeout: 20_000 });
			await expect(home).toHaveAttribute('data-organisation', nameB);
			await expect(home.getByTestId('solde')).toHaveText('À jour');
			await expect(home.getByTestId('payer-mobile-money')).toBeDisabled();
			await expect(home.getByTestId('paiement-explication')).toHaveText(DIRECT_PAYMENT_DISABLED_REASON);
			await expectNoHorizontalOverflow(page, `Mon logement (${label})`);

			// 2. Contrats : en vigueur (B), terminé (A).
			await page.goto('/espace/locataire/contrats');
			await expect(page.getByTestId('groupe-contrats')).toHaveCount(2, { timeout: 20_000 });
			await expect(page.locator('[data-groupe="in_force"]').getByTestId('contrat-locataire')).toHaveAttribute('data-organisation', nameB);
			await expect(page.locator('[data-groupe="ended"]').getByTestId('contrat-locataire')).toHaveAttribute('data-organisation', nameA);
			await expectNoHorizontalOverflow(page, `Contrats (${label})`);

			// 3. Historique unique : les deux agences, chaque élément avec son organisation.
			await page.goto('/espace/locataire/historique');
			const orgs = page.getByTestId('organisation-element');
			await expect(orgs.first()).toBeVisible({ timeout: 20_000 });
			const names = new Set(await orgs.allInnerTexts());
			expect([...names].sort()).toEqual([nameA, nameB].sort());
			await expectNoHorizontalOverflow(page, `Historique (${label})`);

			// 4. Reçus : celui de l'ancienne agence se télécharge (lien signé, journalisé).
			await page.goto('/espace/locataire/recus');
			const former = page.getByTestId('recu-locataire').filter({ hasText: nameA });
			await expect(former.first()).toBeVisible({ timeout: 20_000 });
			const receiptWithPdf = former.filter({ has: page.getByTestId('recu-pdf') }).first();
			const popup = ctx.waitForEvent('page');
			await receiptWithPdf.getByTestId('recu-pdf').click();
			expect((await popup).url()).not.toBe('about:blank');
			await expectNoHorizontalOverflow(page, `Reçus (${label})`);

			// 5. Caution de A : décompte proposé, toute la caution restituée ; contesté avec une observation.
			await page.goto('/espace/locataire/caution');
			const deposit = page.getByTestId('caution').filter({ hasText: nameA });
			const settlement = deposit.getByTestId('decompte');
			await expect(settlement).toHaveAttribute('data-statut', 'proposed', { timeout: 20_000 });
			await expect(settlement.getByTestId('decompte-solde')).toHaveText(formatFcfa(100000));
			await expectNoHorizontalOverflow(page, `Caution et décompte (${label})`);
			await settlement.getByTestId('contester-decompte').click();
			await page.getByTestId('observation').fill('Je n’ai pas reçu la date de la restitution.');
			await page.getByTestId('envoyer-observation').click();
			await expect(page.getByTestId('caution-message')).toHaveText('Observation envoyée : le décompte est contesté.');
			await expect(settlement).toHaveAttribute('data-statut', 'disputed', { timeout: 20_000 });
			await expect(settlement).toContainText('Je n’ai pas reçu la date de la restitution.');

			// 6. Signalement sur le bail en cours, reçu par l'organisation.
			await page.goto('/espace/locataire/signalements');
			await page.getByTestId('nouveau-signalement').click({ timeout: 20_000 });
			await page.getByTestId('signalement-objet').fill('Fuite');
			await page.getByTestId('signalement-description').fill('Le robinet de la cuisine fuit depuis hier.');
			await page.getByTestId('envoyer-signalement').click();
			await expect(page.getByTestId('signalement-message')).toHaveText('Signalement envoyé à votre organisation.');
			await expect(page.getByTestId('signalement-locataire')).toHaveAttribute('data-statut', 'received', { timeout: 20_000 });
			await expectNoHorizontalOverflow(page, `Signalements (${label})`);

			// 7. Demande de préavis sur le bail en cours : transmise, une seconde refusée tant que la première est en cours.
			await page.goto('/espace/locataire/preavis');
			await page.getByTestId('preavis-motif').fill('Mutation professionnelle à Bobo-Dioulasso.', { timeout: 20_000 });
			await page.getByTestId('envoyer-preavis').click();
			await expect(page.getByTestId('preavis-message')).toHaveText('Demande de préavis envoyée à votre organisation.');
			await page.getByTestId('preavis-motif').fill('Deuxième demande.');
			await page.getByTestId('envoyer-preavis').click();
			await expect(page.getByTestId('formulaire-preavis').getByRole('alert')).toBeVisible();
			await expectNoHorizontalOverflow(page, `Préavis (${label})`);
			await ctx.close();
		});
	}
});
