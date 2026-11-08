import { defineConfig } from '@playwright/test';

// Émulation mobile par défaut (téléphone d'entrée de gamme, 360 × 800) ; chaque test peut changer d'appareil.
export default defineConfig({
	testDir: 'e2e',
	fullyParallel: true,
	reporter: [['list']],
	use: {
		baseURL: 'http://localhost:4173',
		viewport: { width: 360, height: 800 },
		isMobile: true,
		hasTouch: true,
		locale: 'fr-FR',
		timezoneId: 'Africa/Ouagadougou'
	},
	webServer: {
		command: 'pnpm build && node build/index.js',
		port: 4173,
		env: { PORT: '4173', HOST: '127.0.0.1', PUBLIC_ORIGIN: 'http://localhost:4173' },
		reuseExistingServer: false,
		timeout: 180_000
	}
});
