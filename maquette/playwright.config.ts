import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'e2e',
	fullyParallel: true,
	reporter: [['list']],
	use: {
		baseURL: 'http://localhost:4173',
		// Émulation d'un Android d'entrée de gamme (lot 00 : 360 × 800).
		viewport: { width: 360, height: 800 },
		isMobile: true,
		hasTouch: true,
		locale: 'fr-FR',
		timezoneId: 'Africa/Ouagadougou',
		serviceWorkers: 'block'
	},
	webServer: {
		command: 'pnpm build && pnpm preview',
		port: 4173,
		reuseExistingServer: false,
		timeout: 180_000
	}
});
