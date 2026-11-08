/**
 * Service worker natif de SvelteKit 3 (D09), enregistré comme module.
 * Il met en cache le code de l'application et les fichiers statiques pour l'installation et le hors ligne.
 * Les données ne passent pas par lui : elles viendront de la base locale (PowerSync, lot 05).
 */
import { version } from '$app/env';
import { assets, immutable } from '$app/manifest';
import { asset } from '$app/paths';
import { self } from '$app/service-worker';

const CACHE = `ziga-${version}`;
// Fichiers de Vite (chemins relatifs à la base) et fichiers de static/ (par asset()), en chemins absolus.
const PRECACHE = [...immutable.map((f) => f.path), ...assets.map((f) => asset(f.path))].map((p) => new URL(p, self.location.href).pathname);
// Les pages de l'application sont rendues côté client : une seule coquille suffit hors ligne.
const SHELL = '/app';

self.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			await cache.addAll([...PRECACHE, SHELL]);
			await self.skipWaiting();
		})()
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
			await self.clients.claim();
		})()
	);
});

self.addEventListener('fetch', (event) => {
	const request = event.request;
	if (request.method !== 'GET') return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;

	event.respondWith(
		(async () => {
			const cache = await caches.open(CACHE);
			// Fichiers versionnés et statiques : toujours depuis le cache.
			const cached = await cache.match(request);
			if (cached && PRECACHE.includes(url.pathname)) return cached;
			try {
				const response = await fetch(request);
				if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
				return response;
			} catch (error) {
				if (cached) return cached;
				// Navigation hors ligne dans l'application : la coquille, qui lira les données locales.
				if (request.mode === 'navigate' && (url.pathname.startsWith('/app') || url.pathname.startsWith('/espace'))) {
					const shell = await cache.match(SHELL);
					if (shell) return shell;
				}
				throw error;
			}
		})()
	);
});
