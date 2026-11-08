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
		// Une seule base partagée : les fichiers s'exécutent l'un après l'autre.
		fileParallelism: false,
		testTimeout: 20_000,
		hookTimeout: 30_000
	}
});
