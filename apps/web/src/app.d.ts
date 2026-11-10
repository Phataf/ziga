// Types de l'application (https://svelte.dev/docs/kit/types#app.d.ts).
declare global {
	/** Vrai seulement dans une version construite avec PUBLIC_E2E=1 (tests de bout en bout, vite.config.ts). */
	const __ZIGA_E2E__: boolean;

	namespace App {
		interface Error {
			code?: string;
		}
		/** État de navigation : « enregistré », pour le message de la page d'arrivée (lot 06). */
		interface PageState {
			saved?: boolean;
		}
	}
}

export {};
