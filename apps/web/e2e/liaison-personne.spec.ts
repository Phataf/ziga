/**
 * Lot 10 ter, étape 3d : la personne lie ses fiches elle-même, sur les trois appareils, sans débordement sur téléphone.
 * - Choix de l'espace : sans fiche liée, aucun espace personnel proposé ; ensuite, seulement ceux de ses fiches.
 * - Invitation reçue par SMS : `/lier/<jeton>` sans session, connexion, retour, code reçu, liaison active, espace ouvert.
 * - Demande à une agence vérifiée (réponse 1) depuis « Mes fiches liées » : code, puis acceptation par l'agence ; retrait
 *   motivé par la personne.
 * - Lien de vérification d'un reçu (`/r/`) : propose de créer un compte, puis de lier sa fiche.
 * - Dépôt d'un document visible du propriétaire et du locataire : l'organisation est avertie (point c).
 */
import { expect, test, type BrowserContextOptions } from '@playwright/test';
import { monthDay, toIsoDate } from '@ziga/shared/dates';
import { newId } from '@ziga/shared/ids';
import { newReceiptToken, provisionalReceiptNumber } from '@ziga/shared/payments';
import { availableUnit, freshAgency, get, login, post, type Agency } from './agency';
import { lastInvitationToken, ownerInAgency } from './portals';
import { accounts, API_URL, expectNoHorizontalOverflow, lastCode, registerViaApi, signInWith, synced } from './support';

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

async function verifiedAgency(request: Parameters<typeof freshAgency>[0], name: string): Promise<Agency> {
	const agency = await freshAgency(request, name);
	// Une agence n'est vérifiée qu'avec son RCCM et son IFU.
	const updated = await request.patch(`${API_URL}/organization`, {
		headers: agency.headers,
		data: { rccm: `BF OUA 2026 B ${agency.id.slice(-4)}`, ifu: `0001${agency.id.slice(-4)}A` }
	});
	expect(updated.status(), await updated.text()).toBeLessThan(300);
	const admin = await login(request, accounts.admin.phone, accounts.admin.password);
	const r = await request.post(`${API_URL}/admin/organizations/${agency.id}/verify`, { headers: { Authorization: `Bearer ${admin}` } });
	expect(r.status()).toBe(204);
	return agency;
}

test.describe('Liaison par la personne, choix de l’espace, liens publics (lot 10 ter, étape 3d)', () => {
	for (const [label, options] of devices) {
		test(`${label} : invitation /lier, demande et acceptation, choix de l’espace, retrait, /r/, avertissement au dépôt`, async ({
			browser,
			request
		}) => {
			test.setTimeout(4 * 60_000);
			const suffix = newId().slice(-6);
			const person = await registerViaApi(request, 'Salif Traoré');

			// Agence A : bail en cours au numéro de la personne, loyer payé (reçu vérifiable), invitation par SMS.
			const a = await freshAgency(request, `Agence Wend-Panga ${suffix}`);
			const { unitId } = await availableUnit(request, a);
			const tenantId = newId();
			await post(request, a.headers, '/tenants', { id: tenantId, fullName: 'Salif Traoré', phone: person.phone });
			const leaseId = newId();
			await post(request, a.headers, '/leases', {
				id: leaseId,
				unitId,
				tenantId,
				startsOn: monthDay(ty, tm, 0, 1),
				rent: 75000,
				charges: 5000,
				lessorType: 'owner'
			});
			const receiptId = newId();
			const verificationToken = newReceiptToken();
			await post(request, a.headers, '/payments', {
				payments: [
					{
						id: newId(),
						leaseId,
						purpose: 'rent',
						amount: 80000,
						method: 'cash',
						paidOn: today,
						receiptId,
						provisionalNumber: provisionalReceiptNumber(receiptId),
						verificationToken,
						shareToken: newReceiptToken()
					}
				]
			});
			await post(request, a.headers, '/person-links', { id: newId(), recordType: 'tenant', recordId: tenantId, sendSms: true });
			const token = lastInvitationToken(person.phone);

			// Agence B, vérifiée : une fiche propriétaire au même numéro.
			const b = await verifiedAgency(request, `Agence Nong-Taaba ${suffix}`);
			await ownerInAgency(request, b, person, { property: 'Cour Nong-Taaba', unit: 'B1' });

			const ctx = await browser.newContext({ ...options, locale: 'fr-FR', timezoneId: 'Africa/Ouagadougou' });
			const page = await ctx.newPage();

			// 1. Lien de vérification du reçu : il propose de créer un compte, puis de lier sa fiche.
			await page.goto(`/r/${verificationToken}`);
			await expect(page.getByTestId('statut-verification')).toBeVisible({ timeout: 20_000 });
			await expect(page.getByTestId('creer-compte')).toHaveAttribute('href', /inscription\?retour=%2Fespace%2Fliaisons$/);
			await expectNoHorizontalOverflow(page, `Vérification du reçu (${label})`);

			// 2. Invitation reçue : aperçu sans session, connexion, retour ici, code, liaison active.
			await page.goto(`/lier/${token}`);
			await expect(page.getByTestId('lier')).toContainText(`Agence Wend-Panga ${suffix}`, { timeout: 20_000 });
			await expect(page.getByTestId('lier')).toContainText('Pour votre fiche de locataire');
			await expectNoHorizontalOverflow(page, `Invitation à lier (${label})`);
			await page.getByTestId('lier-connexion').click();
			await page.getByLabel('Numéro de téléphone').fill(person.national);
			await page.getByLabel('Mot de passe', { exact: true }).fill(person.password);
			await page.getByRole('button', { name: 'Se connecter' }).click();
			await expect(page).toHaveURL(`/lier/${token}`);
			await page.getByTestId('lier-reclamer').click();
			// Le code part au numéro de la fiche avant la réponse : il est lu une fois l'envoi annoncé.
			await expect(page.getByRole('status')).toHaveText('Un code vient de vous être envoyé par SMS.');
			await page.getByLabel('Code reçu par SMS').fill(lastCode(person.phone));
			await page.getByTestId('lier-valider').click();
			await expect(page.getByTestId('lier-fait')).toHaveText('C’est fait : vos données apparaissent dans votre espace.');
			await page.getByTestId('lier-ouvrir').click();
			await expect(page).toHaveURL('/espace/locataire');
			await expect(page.getByTestId('logement-actuel')).toHaveAttribute('data-organisation', `Agence Wend-Panga ${suffix}`, {
				timeout: 20_000
			});

			// 3. Choix de l'espace : seulement l'espace locataire (aucune fiche propriétaire liée).
			await page.goto('/espace');
			await expect(page.getByTestId('espace-tenant')).toBeVisible({ timeout: 20_000 });
			await expect(page.getByTestId('espace-owner')).toHaveCount(0);
			await expectNoHorizontalOverflow(page, `Choix de l’espace (${label})`);

			// 4. Demande à l'agence B, vérifiée : code, puis acceptation par l'agence ; l'espace propriétaire s'ouvre.
			await page.getByTestId('lien-liaisons').click();
			await expect(page).toHaveURL('/espace/liaisons');
			await expect(page.getByTestId('ma-liaison')).toHaveCount(1, { timeout: 20_000 });
			await page.getByTestId('demande-agence').selectOption({ label: `Agence Nong-Taaba ${suffix}` });
			await page.getByTestId('demande-type').selectOption('owner');
			await page.getByTestId('envoyer-demande').click();
			await expect(page.getByTestId('liaison-message')).toHaveText(
				'Si une fiche de cette agence porte votre numéro, un code vient de vous être envoyé par SMS.'
			);
			await page.getByTestId('formulaire-code').getByLabel('Code reçu par SMS').fill(lastCode(person.phone));
			await page.getByTestId('formulaire-code').getByTestId('valider-code').click();
			const requested = page.getByTestId('ma-liaison').filter({ hasText: `Agence Nong-Taaba ${suffix}` });
			await expect(requested).toHaveAttribute('data-etape', 'awaiting_organization', { timeout: 20_000 });
			await expectNoHorizontalOverflow(page, `Mes fiches liées (${label})`);
			const [bOwner] = await get<{ id: string }[]>(request, b.headers, '/owners');
			const links = await get<{ id: string; status: string }[]>(
				request,
				b.headers,
				`/person-links?recordType=owner&recordId=${bOwner!.id}`
			);
			await post(request, b.headers, `/person-links/${links.find((l) => l.status === 'requested')!.id}/accept`, {});
			await page.reload();
			await expect(requested).toHaveAttribute('data-etape', 'active', { timeout: 20_000 });
			await page.goto('/espace');
			await expect(page.getByTestId('espace-owner')).toBeVisible({ timeout: 20_000 });
			await expect(page.getByTestId('espace-tenant')).toBeVisible();

			// 5. Retrait motivé par la personne : l'espace propriétaire n'est plus proposé.
			await page.goto('/espace/liaisons');
			await requested.getByTestId('retirer-liaison').click();
			await page.getByTestId('motif-retrait').fill('Je ne suis plus propriétaire de ce bien');
			await page.getByTestId('confirmer-retrait').click();
			await expect(page.getByTestId('liaison-message')).toHaveText('Liaison retirée.');
			await expect(page.getByTestId('ma-liaison')).toHaveCount(1);
			await page.goto('/espace');
			await expect(page.getByTestId('espace-tenant')).toBeVisible({ timeout: 20_000 });
			await expect(page.getByTestId('espace-owner')).toHaveCount(0);
			await ctx.close();

			// 6. Côté organisation : au dépôt du bail signé, la direction est avertie qu'il sera montré aux deux parties.
			const org = await browser.newContext({ ...options, locale: 'fr-FR', timezoneId: 'Africa/Ouagadougou' });
			const staff = await org.newPage();
			await signInWith(staff, a.director, `/app/baux/${leaseId}`);
			await expect(staff).toHaveURL(`/app/baux/${leaseId}`);
			await synced(staff, 20_000);
			await expect(staff.getByTestId('visibilite-document')).toContainText('le propriétaire et le locataire', { timeout: 20_000 });
			await expectNoHorizontalOverflow(staff, `Dépôt d’un document du bail (${label})`);
			await org.close();
		});
	}
});
