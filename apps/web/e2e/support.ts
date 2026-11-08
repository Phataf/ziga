/**
 * Outils des tests de bout en bout : comptes de test, lecture des SMS écrits par l'API (SMS_DRIVER=file),
 * connexion par l'écran. L'API de test est démarrée par playwright.config.ts (apps/api/scripts/e2e-server.mjs).
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const API_URL = 'http://localhost:3100';
export const SMS_FILE = process.env.E2E_SMS_FILE || join(tmpdir(), 'ziga-e2e', 'sms.jsonl');

const DEMO = 'demo-de-test-e2e';

/**
 * Comptes créés par l'API de test au démarrage (mots de passe de test, base jetable) : une personne sans
 * organisation, le super administrateur et les données de démonstration du lot 03 (apps/api/src/db/seed.ts).
 */
export const accounts = {
	person: { phone: '+22670000002', national: '70 00 00 02', password: 'personne-de-test-e2e', name: 'Awa Ouédraogo' },
	admin: { phone: '+22670000001', national: '70 00 00 01', password: 'admin-de-test-e2e', name: 'Admin Ziga' },
	// Agence A (Faso Immobilier) : un membre par rôle ; la gestionnaire a aussi son organisation de bailleur.
	director: { phone: '+22670010001', national: '70 01 00 01', password: DEMO, name: 'Awa Ouédraogo' },
	managerAndLandlord: { phone: '+22670010002', national: '70 01 00 02', password: DEMO, name: 'Mariam Zongo' },
	fieldAgent: { phone: '+22670010003', national: '70 01 00 03', password: DEMO, name: 'Issa Kaboré' },
	viewer: { phone: '+22670010004', national: '70 01 00 04', password: DEMO, name: 'Salif Traoré' },
	// Agence B (Sahel Habitat).
	directorB: { phone: '+22670020001', national: '70 02 00 01', password: DEMO, name: 'Fatimata Sawadogo' },
	managerB: { phone: '+22670020002', national: '70 02 00 02', password: DEMO, name: 'Boukary Compaoré' }
} as const;

export const ORG_A = 'Faso Immobilier';
export const ORG_B = 'Sahel Habitat';

export type Account = keyof typeof accounts;

/** Dernier code à 6 chiffres envoyé par SMS à ce numéro. */
export function lastCode(phone: string): string {
	const lines = readFileSync(SMS_FILE, 'utf8').trim().split('\n');
	for (const line of lines.reverse()) {
		const sms = JSON.parse(line) as { to: string; text: string };
		const code = sms.to === phone ? /\b(\d{6})\b/.exec(sms.text)?.[1] : undefined;
		if (code) return code;
	}
	throw new Error(`Aucun code envoyé à ${phone}`);
}

let counter = 0;
/** Numéro burkinabè neuf, propre au test (8 chiffres commençant par 7). */
export function newNational(): string {
	counter += 1;
	const n = (Date.now() * 10 + counter + Number(process.env.TEST_PARALLEL_INDEX ?? 0) * 7919) % 10_000_000;
	return `7${String(n).padStart(7, '0')}`;
}

/** Connexion par l'écran, puis arrivée sur `target` (chemin de retour). */
export async function signIn(page: Page, account: Account = 'person', target = '/espace'): Promise<void> {
	const a = accounts[account];
	await page.goto(`/connexion?retour=${encodeURIComponent(target)}`);
	await page.getByLabel('Numéro de téléphone').fill(a.national);
	await page.getByLabel('Mot de passe', { exact: true }).fill(a.password);
	await page.getByRole('button', { name: 'Se connecter' }).click();
	await expect(page).toHaveURL(target);
}

/** Ouvre une organisation depuis le choix de l'espace (personne membre de plusieurs). */
export async function openOrganization(page: Page, label: string | RegExp): Promise<void> {
	await page.goto('/espace');
	await page.getByTestId('espace-organisation').filter({ hasText: label }).click();
	await expect(page).toHaveURL('/app');
}

/** Inscription et vérification par l'API (le code est lu dans le fichier des SMS) ; renvoie le numéro national. */
export async function registerViaApi(
	request: APIRequestContext,
	name: string,
	password = 'mot-de-passe-solide'
): Promise<{ national: string; phone: string; password: string }> {
	const national = newNational();
	const phone = `+226${national}`;
	expect((await request.post(`${API_URL}/auth/register`, { data: { phone, name, password } })).status()).toBe(202);
	expect((await request.post(`${API_URL}/auth/verify-phone`, { data: { phone, code: lastCode(phone) } })).status()).toBe(200);
	return { national, phone, password };
}

/** Connexion par l'écran avec un compte quelconque. */
export async function signInWith(page: Page, who: { national: string; password: string }, target = '/espace'): Promise<void> {
	await page.goto(`/connexion?retour=${encodeURIComponent(target)}`);
	await page.getByLabel('Numéro de téléphone').fill(who.national);
	await page.getByLabel('Mot de passe', { exact: true }).fill(who.password);
	await page.getByRole('button', { name: 'Se connecter' }).click();
}

/**
 * Débordement horizontal, en pixels. En émulation de téléphone, la fenêtre (`innerWidth`) s'élargit avec un contenu
 * trop large et le navigateur dézoome : il faut comparer la largeur du contenu à la largeur de l'écran (`clientWidth`),
 * et lister ce qui dépasse pour un message utile.
 */
export async function horizontalOverflow(page: Page): Promise<{ px: number; culprits: string[] }> {
	return page.evaluate(() => {
		const width = document.documentElement.clientWidth;
		const culprits = [...document.querySelectorAll('body *')]
			.filter((e) => e.getBoundingClientRect().right > width + 0.5)
			.map((e) => `${e.tagName.toLowerCase()} « ${(e.textContent ?? '').trim().slice(0, 40)} »`)
			.slice(0, 5);
		return { px: document.documentElement.scrollWidth - width, culprits };
	});
}

export async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
	const o = await horizontalOverflow(page);
	expect(o.px, `${label} : ${o.culprits.join(' ; ')}`).toBeLessThanOrEqual(0);
}
