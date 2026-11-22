/**
 * Lot 10 ter, étape 3a : côté organisation, sur les trois appareils (docs/UX.md §8), sans débordement sur téléphone.
 * - Fiche locataire, section « Compte lié » : inviter par SMS, renvoyer l'invitation (l'ancienne révoquée, une nouvelle
 *   envoyée, en une action), puis la personne réclame l'invitation et valide son code : lié ; révoquer avec un motif.
 * - Fiche du bail : le signalement du locataire (fait depuis son espace) se planifie puis se marque fait.
 * Données préparées par l'API ; les SMS sont lus dans le fichier des SMS de test.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type BrowserContextOptions } from '@playwright/test';
import { monthDay, toIsoDate } from '@ziga/shared/dates';
import { newId } from '@ziga/shared/ids';
import { availableUnit, freshAgency, get, login, post, type Agency } from './agency';
import { API_URL, expectNoHorizontalOverflow, lastCode, registerViaApi, signInWith, SMS_FILE, synced } from './support';

const phone = { viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true };
const tablet = { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true };
const desktop = { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false };
const devices: [string, BrowserContextOptions][] = [
	['Téléphone (360 × 800)', phone],
	['Tablette (820 × 1180)', tablet],
	['Ordinateur (1440 × 900)', desktop]
];
const [ty, tm] = toIsoDate().split('-').map(Number) as [number, number];

/** Dernier lien d'invitation (`/lier/<jeton>`) envoyé par SMS à ce numéro. */
function lastInvitationToken(to: string): string {
	const lines = readFileSync(SMS_FILE, 'utf8').trim().split('\n').reverse();
	for (const line of lines) {
		const sms = JSON.parse(line) as { to: string; text: string };
		const token = sms.to === to ? /\/lier\/([A-Za-z0-9_.-]+)/.exec(sms.text)?.[1] : undefined;
		if (token) return token;
	}
	throw new Error(`Aucune invitation envoyée à ${to}`);
}

/** Locataire au numéro d'une personne inscrite, avec un bail en vigueur. */
async function tenantWithLease(request: APIRequestContext, agency: Agency) {
	const person = await registerViaApi(request, 'Salif Traoré');
	const { unitId } = await availableUnit(request, agency);
	const tenantId = newId();
	await post(request, agency.headers, '/tenants', { id: tenantId, fullName: 'Salif Traoré', phone: person.phone });
	const leaseId = newId();
	await post(request, agency.headers, '/leases', {
		id: leaseId,
		unitId,
		tenantId,
		startsOn: monthDay(ty, tm, -3, 1),
		rent: 75000,
		charges: 5000,
		lessorType: 'owner'
	});
	const token = await login(request, person.phone, person.password);
	return { person, tenantId, leaseId, personHeaders: { Authorization: `Bearer ${token}` } };
}

test.describe('Compte lié et signalements, côté organisation (lot 10 ter, étape 3a)', () => {
	for (const [label, options] of devices) {
		test(`${label} : inviter, renvoyer l’invitation, liaison, révocation ; signalement planifié puis fait`, async ({
			browser,
			request
		}) => {
			test.setTimeout(3 * 60_000);
			const agency = await freshAgency(request, `Agence compte lié ${newId().slice(-6)}`);
			const { person, tenantId, leaseId, personHeaders } = await tenantWithLease(request, agency);
			const ctx = await browser.newContext({ ...options, locale: 'fr-FR', timezoneId: 'Africa/Ouagadougou' });
			const page = await ctx.newPage();
			await signInWith(page, agency.director, `/app/locataires/${tenantId}`);
			await expect(page).toHaveURL(`/app/locataires/${tenantId}`);
			await synced(page, 20_000);

			// 1. Inviter par SMS, puis « Renvoyer l'invitation » : l'ancienne révoquée, une nouvelle envoyée.
			const section = page.getByTestId('compte-lie');
			await expect(section.getByTestId('compte-lie-etat')).toContainText('Aucun compte lié');
			await section.getByTestId('inviter-sms').click();
			await expect(section.getByTestId('compte-lie-message')).toHaveText('Invitation envoyée par SMS.');
			await expect(section.getByTestId('compte-lie-etat')).toContainText('Invitation envoyée');
			const first = lastInvitationToken(person.phone);
			await expectNoHorizontalOverflow(page, `Fiche locataire, compte lié (${label})`);
			await section.getByTestId('renvoyer-sms').click();
			await expect(section.getByTestId('compte-lie-message')).toHaveText('Invitation envoyée par SMS.');
			await expect.poll(() => lastInvitationToken(person.phone)).not.toBe(first);
			const links = await get<{ status: string; revocationReason: string | null }[]>(
				request,
				agency.headers,
				`/person-links?recordType=tenant&recordId=${tenantId}`
			);
			expect(links.map((l) => [l.status, l.revocationReason])).toEqual([
				['requested', null],
				['revoked', 'Invitation renvoyée']
			]);

			// 2. La personne réclame la nouvelle invitation et valide son code : la fiche dit « lié ».
			const token = lastInvitationToken(person.phone);
			const claim = await request.post(`${API_URL}/person-link-invitations/${token}/claim`, { headers: personHeaders });
			expect(claim.status()).toBe(200);
			const { linkId } = (await claim.json()) as { linkId: string };
			const verify = await request.post(`${API_URL}/me/person-links/${linkId}/verify`, {
				headers: personHeaders,
				data: { organizationId: agency.id, code: lastCode(person.phone) }
			});
			expect(verify.status()).toBe(200);
			await page.reload();
			await expect(section.getByTestId('compte-lie-etat')).toContainText('Lié au compte de la personne');

			// 3. Signalement fait depuis l'espace du locataire, suivi depuis la fiche du bail.
			const report = await request.post(`${API_URL}/me/portal/tenant/requests`, {
				headers: personHeaders,
				data: { organizationId: agency.id, id: newId(), leaseId, title: 'Fuite', description: 'Le robinet de la cuisine fuit depuis hier.' }
			});
			expect(report.status()).toBe(201);
			await page.goto(`/app/baux/${leaseId}`);
			const card = page.getByTestId('signalement');
			await expect(card).toHaveAttribute('data-statut', 'received', { timeout: 20_000 });
			await expectNoHorizontalOverflow(page, `Fiche du bail, signalements (${label})`);
			await card.getByTestId('planifier-signalement').click();
			await page.getByTestId('date-passage').fill(monthDay(ty, tm, 1, 2));
			await page.getByTestId('mot-signalement').fill('Plombier mardi matin.');
			await page.getByTestId('enregistrer-signalement').click();
			await expect(card).toHaveAttribute('data-statut', 'planned', { timeout: 20_000 });
			await expect(card).toContainText('Plombier mardi matin.');
			await card.getByTestId('signalement-fait').click();
			await page.getByTestId('mot-signalement').fill('Joint changé.');
			await page.getByTestId('enregistrer-signalement').click();
			await expect(card).toHaveAttribute('data-statut', 'done', { timeout: 20_000 });
			const seen = (await (await request.get(`${API_URL}/me/portal/tenant/requests`, { headers: personHeaders })).json()) as {
				status: string;
			}[];
			expect(seen.map((r) => r.status)).toEqual(['done']);

			// 4. Révoquer, avec un motif : la personne ne voit plus rien ; la fiche propose de nouveau l'invitation.
			await page.goto(`/app/locataires/${tenantId}`);
			await section.getByTestId('revoquer-liaison').click();
			await page.getByTestId('motif-revocation').fill('Le locataire a demandé la fin de la liaison');
			await page.getByTestId('confirmer-revocation').click();
			await expect(section.getByTestId('compte-lie-message')).toHaveText('Liaison révoquée.');
			await expect(section.getByTestId('compte-lie-etat')).toContainText('Aucun compte lié');
			const mine = (await (await request.get(`${API_URL}/me/person-links`, { headers: personHeaders })).json()) as unknown[];
			expect(mine).toEqual([]);
			await expectNoHorizontalOverflow(page, `Fiche locataire après révocation (${label})`);
			await ctx.close();
		});
	}
});
