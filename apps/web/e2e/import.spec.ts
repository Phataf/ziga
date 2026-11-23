/**
 * Lot 11 : import Excel, contre la vraie API, le vrai worker (lecture, analyse, exécution en tâche de fond) et le vrai
 * service PowerSync. Registre fictif de l'agence (apps/api/test/fixtures/imports/registre-fictif.xlsx).
 * - Sur téléphone, tablette et ordinateur, sans débordement : modèle téléchargé ; envoi avec la date de bascule (le 1er
 *   du mois en cours par défaut) ; prévisualisation exacte (lignes en erreur et leur motif, quartiers à corriger,
 *   avertissement des soldes antérieurs) ; exécution refusée tant que le choix unique des cautions sans montant reçu
 *   n'est pas fait ; import terminé, rapport téléchargé ; bail importé avec son « Solde antérieur » ; premier reçu le
 *   jour même ; annulation alors refusée (un encaissement depuis) ; « Contrats à déposer » et un scan déposé ; signal
 *   « Une autre fiche porte ce numéro » sur la fiche d'un locataire.
 * - Annulation dans les 24 heures, sans encaissement : les baux de l'import sont annulés, plus aucun contrat à déposer.
 * - Facturation du premier mois en entier : seule la date du 1er d'un mois est proposée, et l'écran dit pourquoi.
 * - Bailleur particulier : l'import est dans sa navigation, son modèle n'a pas d'onglet Propriétaires.
 * - L'import est en ligne seulement : l'écran le dit, hors connexion l'envoi est impossible.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import { toIsoDate } from '@ziga/shared/dates';
import { newId } from '@ziga/shared/ids';
import { PDFDocument } from 'pdf-lib';
import readXlsxFile from 'read-excel-file/node';
import { freshAgency, get, login, receivedWhen, type Agency } from './agency';
import { accounts, API_URL, expectNoHorizontalOverflow, registerViaApi, signInWith, synced } from './support';

const phone = { viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true };
const tablet = { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true };
const desktop = { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false };
const today = toIsoDate();
const firstOfMonth = `${today.slice(0, 7)}-01`;
const REGISTRY = join(import.meta.dirname, '../../api/test/fixtures/imports/registre-fictif.xlsx');

async function onePagePdf(): Promise<Buffer> {
	const doc = await PDFDocument.create();
	doc.addPage([595, 842]);
	return Buffer.from(await doc.save());
}

async function open(browser: Browser, options: BrowserContextOptions, who: { national: string; password: string }, target: string) {
	const ctx = await browser.newContext({ ...options, locale: 'fr-FR', timezoneId: 'Africa/Ouagadougou', baseURL: 'http://localhost:4173' });
	const page = await ctx.newPage();
	await signInWith(page, who, target);
	await expect(page).toHaveURL(target);
	await synced(page, 20_000);
	return { ctx, page };
}

/** Envoi du registre fictif depuis l'écran ; renvoie la page de l'import (analyse terminée). */
async function sendRegistry(page: Page, label: string): Promise<void> {
	await page.goto('/app/import');
	await expect(page.getByTestId('import')).toBeVisible();
	await expect(page.getByTestId('en-ligne-seulement')).toBeVisible();
	await expect(page.getByTestId('date-bascule')).toHaveValue(firstOfMonth);
	await expectNoHorizontalOverflow(page, `${label} : envoi`);
	await page.getByTestId('fichier-import').setInputFiles(REGISTRY);
	await page.getByTestId('envoyer-import').click();
	await expect(page).toHaveURL(/\/app\/import\/[0-9a-f-]{36}$/, { timeout: 20_000 });
	await expect(page.getByTestId('statut-import')).toHaveAttribute('data-statut', 'analyzed', { timeout: 60_000 });
}

/** Choix de la prévisualisation : cautions sans montant reçu versées en entier ; « Tampoui » corrigé en Tampouy. */
async function chooseAndRun(page: Page, label: string): Promise<void> {
	await page.getByTestId('caution-full').check();
	const tampoui = page.getByTestId('lieu').filter({ hasText: 'Tampoui' });
	await tampoui.getByTestId('lieu-choix').selectOption({ label: 'Tampouy (Ouagadougou)' });
	await page.getByTestId('appliquer-choix').click();
	await expect(page.getByTestId('statut-import')).toHaveAttribute('data-statut', 'analyzed', { timeout: 60_000 });
	await expect(page.getByTestId('blocage')).toHaveCount(0);
	await expect(page.getByTestId('lieu').filter({ hasText: 'Tampoui' })).toHaveAttribute('data-statut', 'corrected');
	await expectNoHorizontalOverflow(page, `${label} : choix faits`);
	await page.getByTestId('lancer-import').click();
	await expect(page.getByTestId('statut-import')).toHaveAttribute('data-statut', 'completed', { timeout: 120_000 });
}

/** Bail qui porte un « Solde antérieur » de 250 000 FCFA (unité B-01-V), lu dans le flux synchronisé. */
async function openingBalanceLease(request: APIRequestContext, agency: Agency): Promise<string> {
	const token = await login(request, agency.director.phone, agency.director.password);
	const rows = await receivedWhen(
		request,
		token,
		(r) => r.some((x) => x.table === 'rent_dues' && x.data.kind === 'opening_balance' && Number(x.data.amount_due) === 250000),
		30_000
	);
	const due = rows.find((x) => x.table === 'rent_dues' && x.data.kind === 'opening_balance' && Number(x.data.amount_due) === 250000)!;
	const lease = rows.find((x) => x.table === 'leases' && x.data.id === due.data.lease_id)!;
	expect(lease.data.import_job_id).toBeTruthy();
	return String(due.data.lease_id);
}

for (const [label, options] of [
	['téléphone', phone],
	['tablette', tablet],
	['ordinateur', desktop]
] as const) {
	test(`${label} : registre importé, premier reçu le jour même, contrats à déposer, fiche en double`, async ({ browser, request }) => {
		test.setTimeout(300_000);
		const agency = await freshAgency(request, `Agence import ${label}`);
		const { ctx, page } = await open(browser, options, agency.director, '/app/import');

		// Modèle à remplir, aux onglets d'une agence.
		const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('telecharger-modele').click()]);
		expect(download.suggestedFilename()).toBe('modele-import-ziga.xlsx');
		const sheets = await readXlsxFile(readFileSync((await download.path())!));
		expect(sheets.map((s) => s.sheet)).toEqual(expect.arrayContaining(['Notice', 'Propriétaires', 'Biens', 'Baux', 'Soldes d’ouverture']));

		await sendRegistry(page, label);

		// Prévisualisation exacte : chaque erreur dit la ligne, la colonne et quoi corriger ; la cascade est dite.
		const preview = page.getByTestId('apercu');
		await expect(preview.getByTestId('onglet-apercu')).toHaveCount(7);
		const errors = page.getByTestId('ligne-import').filter({ has: page.locator('[data-severite="error"]') });
		await expect(errors).toHaveCount(4);
		for (const text of await errors.allTextContents()) expect(text).toMatch(/Ligne \d+ de .+, colonne .+ : /);
		await expect(page.getByTestId('ligne-import').filter({ hasText: 'Saisissez 0 et notez l’avance' })).toHaveCount(1);
		await expect(page.getByTestId('avertissement-soldes')).toContainText('ont un solde antérieur, ils apparaîtront dans les impayés');
		// Choix unique des cautions sans montant reçu : sans lui, l'exécution est refusée.
		await expect(page.getByTestId('blocage')).toHaveCount(1);
		await expect(page.getByTestId('lancer-import')).toBeDisabled();
		await expect(page.getByTestId('choix-cautions')).toContainText('38');
		await expect(page.getByTestId('lieu').filter({ hasText: 'Tampoui' })).toHaveAttribute('data-statut', 'unresolved');
		await expectNoHorizontalOverflow(page, `${label} : prévisualisation`);

		await chooseAndRun(page, label);

		// Compte rendu par onglet et rapport téléchargeable.
		await expect(page.getByTestId('rapport-onglet')).toHaveCount(7);
		await expect(page.getByTestId('rapport-onglet').filter({ hasText: 'Baux' })).toHaveAttribute('data-statut', 'done');
		const [report] = await Promise.all([page.waitForEvent('download'), page.getByTestId('telecharger-rapport').click()]);
		expect(report.suggestedFilename()).toMatch(/^rapport-import-\d{4}-\d{2}-\d{2}\.xlsx$/);
		const reportRows = (await readXlsxFile(readFileSync((await report.path())!)))[0]!.data;
		expect(reportRows[0]).toEqual(['Onglet', 'Ligne', 'Statut', 'Élément', 'Message']);
		await expect(page.getByTestId('annuler-import')).toBeVisible();
		await expectNoHorizontalOverflow(page, `${label} : import terminé`);

		// Bail importé : « Solde antérieur » dans l'échéancier, puis premier reçu le jour même.
		const leaseId = await openingBalanceLease(request, agency);
		await page.goto(`/app/baux/${leaseId}`);
		const opening = page.getByTestId('echeance').filter({ hasText: 'Solde antérieur' });
		await expect(opening).toHaveCount(1, { timeout: 20_000 });
		await expect(opening).toHaveAttribute('data-kind', 'opening_balance');
		await expectNoHorizontalOverflow(page, `${label} : bail importé`);
		await page.getByTestId('encaisser-loyer').click();
		await expect(page.getByTestId('montant')).toHaveValue(/^[1-9]\d*$/);
		await page.getByTestId('valider-encaissement').click();
		await expect(page.getByTestId('recu')).toBeVisible();
		await expect(page.getByTestId('statut-encaissement')).toHaveText('Confirmé', { timeout: 20_000 });
		await expect(page.getByTestId('numero-recu')).not.toHaveText(/PROV/, { timeout: 20_000 });
		await expect(page.getByTestId('recu')).toContainText('Solde antérieur');

		// Un encaissement depuis l'import : l'annulation est refusée, avec le motif.
		await page.goto('/app/import');
		await page.getByTestId('import-ligne').first().click();
		await page.getByTestId('annuler-import').click();
		await page.getByTestId('motif-annulation').fill('Mauvais fichier envoyé');
		await page.getByTestId('confirmer-annulation').click();
		await expect(page.getByTestId('import-detail').getByRole('alert')).toContainText('encaissement');
		await expect(page.getByTestId('statut-import')).toHaveAttribute('data-statut', 'completed');

		// Contrats à déposer : baux de l'import sans scan signé ; un scan déposé retire son bail de la liste.
		await page.getByTestId('lien-contrats-a-deposer').click();
		await expect(page).toHaveURL('/app/import/contrats');
		const items = page.getByTestId('contrat-a-deposer');
		await expect(items.first()).toBeVisible({ timeout: 20_000 });
		const before = await items.count();
		expect(before).toBeGreaterThanOrEqual(40);
		await expectNoHorizontalOverflow(page, `${label} : contrats à déposer`);
		const first = items.first();
		const unit = (await first.getByTestId('unite-a-deposer').textContent())!.trim();
		await first
			.getByTestId('scan-fichier')
			.setInputFiles({ name: 'bail-signe.pdf', mimeType: 'application/pdf', buffer: await onePagePdf() });
		await first.getByTestId('deposer-scan').click();
		await expect(items.filter({ has: page.getByTestId('unite-a-deposer').getByText(unit, { exact: true }) })).toHaveCount(0, {
			timeout: 30_000
		});
		await expect(items).toHaveCount(before - 1);

		// Fiche en double : la famille au même numéro (Kaboré Awa et Kaboré Alima).
		const tenants = await get<{ id: string; fullName: string }[]>(request, agency.headers, '/tenants');
		const awa = tenants.find((t) => t.fullName === 'Kaboré Awa')!;
		await page.goto(`/app/locataires/${awa.id}`);
		const same = page.getByTestId('meme-numero');
		await expect(same).toBeVisible({ timeout: 20_000 });
		await expect(same).toContainText('Une autre fiche porte ce numéro');
		await expect(same.getByTestId('meme-numero-lien')).toHaveText('Kaboré Alima');
		await expectNoHorizontalOverflow(page, `${label} : fiche au même numéro`);
		await ctx.close();
	});
}

test('annulation dans les 24 heures, sans encaissement : baux annulés, plus rien à déposer (ordinateur)', async ({ browser, request }) => {
	test.setTimeout(240_000);
	const agency = await freshAgency(request, 'Agence import annulé');
	const { ctx, page } = await open(browser, desktop, agency.director, '/app/import');
	await sendRegistry(page, 'annulation');
	await chooseAndRun(page, 'annulation');
	await expect(page.getByTestId('delai-annulation')).toBeVisible();
	await page.getByTestId('annuler-import').click();
	await page.getByTestId('motif-annulation').fill('Mauvais fichier envoyé');
	await page.getByTestId('confirmer-annulation').click();
	await expect(page.getByTestId('statut-import')).toHaveAttribute('data-statut', 'cancelled', { timeout: 60_000 });
	await expect(page.getByTestId('import-detail')).toContainText('Mauvais fichier envoyé');
	await expect(page.getByTestId('annuler-import')).toHaveCount(0);
	await page.goto('/app/import/contrats');
	await expect(page.getByTestId('contrats-a-deposer')).toBeVisible();
	await expect(page.getByTestId('contrat-a-deposer')).toHaveCount(0, { timeout: 30_000 });
	await ctx.close();
});

test('facturation du premier mois en entier : seulement le 1er d’un mois, expliqué à l’écran (téléphone)', async ({ browser, request }) => {
	const agency = await freshAgency(request, 'Agence mois entier');
	const r = await request.put(`${API_URL}/organization/rent-billing-mode`, {
		headers: agency.headers,
		data: { mode: 'calendar_full_first' }
	});
	expect(r.status(), await r.text()).toBeLessThan(300);
	const { ctx, page } = await open(browser, phone, agency.director, '/app/import');
	const input = page.getByTestId('date-bascule');
	await expect(input).toHaveValue(firstOfMonth);
	const values = await input.locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value));
	expect(values.length).toBeGreaterThan(1);
	expect(values.every((v) => v.endsWith('-01') && v <= today)).toBe(true);
	await expect(page.getByTestId('aide-bascule')).toContainText('premier mois en entier');
	await expectNoHorizontalOverflow(page, 'mois entier : envoi');
	await ctx.close();
});

test('bailleur particulier : import dans sa navigation, modèle sans onglet Propriétaires (téléphone)', async ({ browser, request }) => {
	const who = await registerViaApi(request, 'Bailleur importateur');
	const token = await login(request, who.phone, who.password);
	const id = newId();
	const created = await request.post(`${API_URL}/organizations`, {
		headers: { Authorization: `Bearer ${token}` },
		data: { id, type: 'landlord', legalName: 'Bailleur importateur', phone: who.phone, commune: 'Ouagadougou' }
	});
	expect(created.status()).toBe(201);
	const admin = await login(request, accounts.admin.phone, accounts.admin.password);
	const plan = await request.put(`${API_URL}/admin/organizations/${id}/plan`, {
		headers: { Authorization: `Bearer ${admin}` },
		data: { planId: 'pro', reason: 'Test de bout en bout : import' }
	});
	expect(plan.status()).toBe(204);
	const { ctx, page } = await open(browser, phone, who, '/app/plus');
	await page.getByRole('link', { name: 'Import Excel' }).click();
	await expect(page).toHaveURL('/app/import');
	const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('telecharger-modele').click()]);
	const sheets = await readXlsxFile(readFileSync((await download.path())!));
	expect(sheets.map((s) => s.sheet)).not.toContain('Propriétaires');
	expect(sheets.map((s) => s.sheet)).toContain('Baux');
	await expectNoHorizontalOverflow(page, 'bailleur : envoi');
	await ctx.close();
});

test('en ligne seulement : hors connexion, l’envoi est impossible et l’écran le dit (téléphone)', async ({ browser, request }) => {
	const agency = await freshAgency(request, 'Agence import hors ligne');
	const { ctx, page } = await open(browser, phone, agency.director, '/app/import');
	await ctx.setOffline(true);
	await expect(page.getByTestId('hors-ligne-import')).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId('envoyer-import')).toBeDisabled();
	await ctx.setOffline(false);
	await ctx.close();
});
