/**
 * Police de secours (lot 03, correctif CI) : l'application demande Inter, absente du runner de la CI, qui se rabat sur
 * une police plus large. Chaque écran est vérifié à 360 px avec DejaVu Sans, plus large encore : aucun élément ne doit
 * déborder ni en recouvrir un autre, quelles que soient les polices installées.
 */
import { test } from '@playwright/test';
import { expectNoHorizontalOverflow, signIn } from './support';
test.use({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true });
const wide = '*{font-family:"DejaVu Sans",sans-serif !important}';
test('police large : aucun écran ne déborde à 360 px', async ({ page }) => {
	await page.addInitScript((css) => {
		document.addEventListener('DOMContentLoaded', () => {
			const s = document.createElement('style');
			s.textContent = css;
			document.head.append(s);
		});
	}, wide);
	for (const path of ['/connexion', '/inscription', '/mot-de-passe-oublie', '/verification?numero=%2B22670123456', '/']) {
		await page.goto(path);
		await page.waitForLoadState('networkidle');
		await expectNoHorizontalOverflow(page, path);
	}
	await signIn(page, 'director', '/app');
	for (const path of [
		'/app',
		'/app/plus',
		'/app/equipe',
		'/app/organisation',
		'/app/journal',
		'/espace',
		'/espace/compte',
		'/espace/appareils',
		'/espace/nouvelle-organisation',
		'/espace/proprietaire',
		'/espace/locataire/caution'
	]) {
		await page.goto(path);
		await page.waitForLoadState('networkidle');
		await expectNoHorizontalOverflow(page, path);
	}
});
