import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

// SMS de l'API de test, écrits dans un fichier lu par les tests (e2e/support.ts).
const smsDir = join(tmpdir(), 'ziga-e2e');
mkdirSync(smsDir, { recursive: true });
process.env.E2E_SMS_FILE ||= join(smsDir, 'sms.jsonl');

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
	webServer: [
		{
			// Vraie API, sur une base `ziga_e2e` recréée à chaque exécution (apps/api/scripts/e2e-server.mjs).
			command: 'pnpm --filter @ziga/api build && node ../api/scripts/e2e-server.mjs',
			url: 'http://localhost:3100/health/ready',
			env: { E2E_SMS_FILE: process.env.E2E_SMS_FILE, E2E_API_PORT: '3100', E2E_WEB_ORIGIN: 'http://localhost:4173' },
			reuseExistingServer: false,
			timeout: 180_000
		},
		{
			command: 'pnpm build && node build/index.js',
			port: 4173,
			env: { PORT: '4173', HOST: '127.0.0.1', PUBLIC_ORIGIN: 'http://localhost:4173', PUBLIC_API_URL: 'http://localhost:3100' },
			reuseExistingServer: false,
			timeout: 180_000
		}
	]
});
