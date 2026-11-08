import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC compile les décorateurs de NestJS avec leurs métadonnées (esbuild ne les émet pas).
export default defineConfig({
	plugins: [swc.vite({ module: { type: 'es6' } })],
	test: { include: ['src/**/*.test.ts'], environment: 'node' }
});
