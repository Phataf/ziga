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
			// Dossier de sortie réglable : le test de la version de production construit à part (e2e-hook.build.test.ts).
			adapter: adapter({ out: process.env.ZIGA_BUILD_OUT || 'build' }),
			// Le fichier .env est à la racine du dépôt, partagé avec l'API.
			env: { dir: '../..' },
			paths: {
				// Origine publique (remplace la variable ORIGIN d'adapter-node).
				origin: process.env.PUBLIC_ORIGIN || 'http://localhost:5173',
				// Chemins absolus : la coquille hors ligne (/app) sert n'importe quelle page de l'application.
				relative: false
			}
		})
	],
	// Accès des tests de bout en bout (lot 05) : compilé seulement si PUBLIC_E2E=1 au moment du build ; sinon éliminé.
	define: { __ZIGA_E2E__: JSON.stringify(process.env.PUBLIC_E2E === '1') },
	// PowerSync (lot 05) : le SDK contient des workers et du WebAssembly, que Vite ne doit pas pré-assembler ;
	// ses workers sont des modules ES.
	optimizeDeps: { exclude: ['@powersync/web'] },
	worker: { format: 'es' },
	// Port réglable par WEB_PORT (lu ici plutôt que dans un script : la syntaxe ${…:-…} n'existe pas sous Windows).
	server: { port: Number(process.env.WEB_PORT || 5173), strictPort: true },
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node'
	}
});
