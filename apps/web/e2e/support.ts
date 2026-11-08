/**
 * Outils des tests de bout en bout : comptes de test, lecture des SMS écrits par l'API (SMS_DRIVER=file),
 * connexion par l'écran. L'API de test est démarrée par playwright.config.ts (apps/api/scripts/e2e-server.mjs).
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';

export const API_URL = 'http://localhost:3100';
export const SMS_FILE = process.env.E2E_SMS_FILE || join(tmpdir(), 'ziga-e2e', 'sms.jsonl');

/** Comptes créés par l'API de test au démarrage (mots de passe de test, base jetable). */
export const accounts = {
	person: { phone: '+22670000002', national: '70 00 00 02', password: 'personne-de-test-e2e', name: 'Awa Ouédraogo' },
	admin: { phone: '+22670000001', national: '70 00 00 01', password: 'admin-de-test-e2e', name: 'Admin Ziga' }
} as const;

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
