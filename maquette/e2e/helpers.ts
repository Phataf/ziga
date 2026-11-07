import { expect, type Page } from '@playwright/test';

/** Date figée de la démo : samedi 07/11/2026, 10 h (Ouagadougou). */
export const DEMO_NOW = new Date('2026-11-07T10:00:00Z');

export async function openDemo(page: Page, path = '/') {
	await page.clock.setFixedTime(DEMO_NOW);
	// Les liens wa.me et tel: ne doivent pas quitter la démo pendant les tests.
	await page.context().route('https://wa.me/**', (route) => route.fulfill({ body: 'WhatsApp', contentType: 'text/plain' }));
	await page.goto(path);
	await page.evaluate(() => localStorage.clear());
	await page.goto(path);
}

export async function tab(page: Page, name: 'Accueil' | 'Biens' | 'Encaissements' | 'Plus') {
	await page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('link', { name }).tap();
}

/** Les montants utilisent des espaces insécables : on compare en ignorant le type d'espace. */
export function amount(text: string): RegExp {
	return new RegExp(text.replace(/ /g, '\\s'));
}

export async function expectTapTarget(page: Page, selector: string) {
	const boxes = await page.locator(selector).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
	for (const h of boxes) expect(h).toBeGreaterThanOrEqual(44);
}
