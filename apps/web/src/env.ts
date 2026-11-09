/**
 * Variables d'environnement de l'interface (SvelteKit 3, `defineEnvVars`).
 * PUBLIC_API_URL est lue au démarrage du serveur (pas figée au build) : la même image sert la préproduction
 * et la production (D28).
 */
import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	PUBLIC_API_URL: {
		public: true,
		description: 'Adresse publique de l’API, sans barre finale (ex. https://api.ziga.com).',
		schema: (value) => {
			const url = (value || 'http://localhost:3000').replace(/\/+$/, '');
			if (!/^https?:\/\/[^/]+/.test(url)) throw new Error('PUBLIC_API_URL doit être une adresse http(s).');
			return url;
		}
	},
	PUBLIC_E2E: {
		public: true,
		description:
			'« 1 » seulement pour les tests de bout en bout : expose le nombre de lignes de la base locale (jamais leur contenu), pour vérifier qu’elle se vide.',
		schema: (value) => value === '1'
	}
});
