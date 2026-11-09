/**
 * Connecteur entre la base locale et le serveur (lot 05).
 * - fetchCredentials : jeton dédié de PowerSync, demandé à l'API (GET /sync/credentials). Hors connexion, ou si l'API
 *   ne répond pas, une erreur : PowerSync réessaiera. Seul un refus explicite de l'API (401) ferme la session, et
 *   c'est le module d'authentification qui en décide (lot 02), jamais un refus de PowerSync.
 * - uploadData : envoi des modifications locales, à l'étape 3 du lot 05 (aucune écriture locale avant).
 */
import type { AbstractPowerSyncDatabase, PowerSyncBackendConnector, PowerSyncCredentials } from '@powersync/web';
import { auth } from '../auth/auth.svelte';

export class ZigaConnector implements PowerSyncBackendConnector {
	async fetchCredentials(): Promise<PowerSyncCredentials> {
		const r = await auth.request<{ endpoint: string; token: string; expiresAt: string }>('GET', '/sync/credentials');
		return { endpoint: r.endpoint, token: r.token, expiresAt: new Date(r.expiresAt) };
	}

	async uploadData(_database: AbstractPowerSyncDatabase): Promise<void> {
		// Étape 3 du lot 05 : POST /sync/upload. Aucune table n'est encore modifiable en local.
	}
}
