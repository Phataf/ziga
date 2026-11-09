import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';
import { integrationEnv } from './test/env.js';

export default defineConfig({
	plugins: [swc.vite({ module: { type: 'es6' } })],
	test: {
		include: ['test/**/*.int.test.ts'],
		environment: 'node',
		env: integrationEnv(),
		globalSetup: ['test/global-setup.ts'],
		// Avant chaque fichier : compteurs de débit remis à zéro (test/file-setup.ts, test/test-isolation.int.test.ts).
		setupFiles: ['test/file-setup.ts'],
		// Une seule base partagée : les fichiers s'exécutent l'un après l'autre. Redis aussi : chaque fichier la remet
		// à zéro au départ, sauf les clés ziga:test:* (blocs de numéros, test/test-redis.ts).
		fileParallelism: false,
		testTimeout: 20_000,
		hookTimeout: 30_000
	}
});
