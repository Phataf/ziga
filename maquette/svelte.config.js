import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// Application 100 % statique : toutes les pages sont rendues côté client
		// et l'hébergeur renvoie index.html pour toute route inconnue.
		adapter: adapter({ fallback: 'index.html' }),
		alias: { $lib: 'src/lib' }
	}
};

export default config;
