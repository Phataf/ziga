/**
 * SvelteKit 3 : la configuration passe par le plugin `sveltekit(...)` (plus de svelte.config.js).
 * L'alias `#lib` est déclaré dans package.json (« imports »), à la place de `$lib`.
 */
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Runes partout dans le projet, sauf les bibliothèques.
				runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
			},
			adapter: adapter({ out: 'build' }),
			paths: {
				// Origine publique (remplace la variable ORIGIN d'adapter-node).
				origin: process.env.PUBLIC_ORIGIN || 'http://localhost:5173',
				// Chemins absolus : la coquille hors ligne (/app) sert n'importe quelle page de l'application.
				relative: false
			}
		})
	],
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node'
	}
});
