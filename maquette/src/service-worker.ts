/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/**
 * Service worker de la maquette : met en cache l'application et les fichiers statiques
 * pour qu'elle s'ouvre hors connexion et s'installe sur l'écran d'accueil.
 */
import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `immo-demo-${version}`;
// index.html est la page de repli de l'export statique : toutes les routes l'utilisent.
const ASSETS = [...build, ...files, '/index.html'];

sw.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(ASSETS))
			.then(() => sw.skipWaiting())
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => sw.clients.claim())
	);
});

sw.addEventListener('fetch', (event) => {
	const request = event.request;
	if (request.method !== 'GET') return;
	const url = new URL(request.url);
	if (url.origin !== sw.location.origin) return;

	// Navigation : la coquille de l'application vient du cache (instantané en 3G et hors connexion).
	// Une nouvelle version du site installe un nouveau service worker et un nouveau cache.
	if (request.mode === 'navigate') {
		event.respondWith(caches.match('/index.html').then((cached) => cached ?? fetch(request)));
		return;
	}

	// Fichiers statiques : cache d'abord.
	event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
});
