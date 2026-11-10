/**
 * Connecteur entre la base locale et le serveur (lot 05).
 * - fetchCredentials : jeton dédié de PowerSync, demandé à l'API (GET /sync/credentials). Hors connexion, ou si l'API
 *   ne répond pas, une erreur : PowerSync réessaiera. Seul un refus explicite de l'API (401) ferme la session, et
 *   c'est le module d'authentification qui en décide (lot 02), jamais un refus de PowerSync.
 * - uploadData : les modifications faites sur l'appareil, envoyées par lots (POST /sync/upload), chacune avec sa clé
 *   d'idempotence (base locale et numéro de l'opération). L'API répond 200 avec un résultat par opération : le lot
 *   quitte la file, et la synchronisation suivante remet la valeur du serveur là où une opération a été refusée ; le refus
 *   est gardé dans « Modifications non acceptées » (rejections.ts). Une
 *   erreur passagère (réseau, 5xx) laisse le lot dans la file : PowerSync le renverra, sans doublon.
 */
import type { AbstractPowerSyncDatabase, PowerSyncBackendConnector, PowerSyncCredentials } from '@powersync/web';
import { SYNC_BATCH_MAX, type SyncOperation, type SyncOperationResult, type SyncUploadResponse } from '@ziga/shared/sync';
import { auth } from '../auth/auth.svelte';
import { localOrganizationLookup, toOperations } from './upload';

/**
 * Opérations refusées par le serveur, avec ce qui avait été envoyé (liste « Modifications non acceptées », étape 4).
 * Appelé avant que le lot quitte la file : si l'écriture locale échoue, le lot est renvoyé, et le serveur rend le
 * même refus (rejeu), sans doublon dans la liste.
 */
export type RejectionListener = (
	database: AbstractPowerSyncDatabase,
	rejected: { operation: SyncOperation; result: SyncOperationResult }[]
) => Promise<void> | void;

export class ZigaConnector implements PowerSyncBackendConnector {
	constructor(private readonly onRejected?: RejectionListener) {}

	async fetchCredentials(): Promise<PowerSyncCredentials> {
		const r = await auth.request<{ endpoint: string; token: string; expiresAt: string }>('GET', '/sync/credentials');
		return { endpoint: r.endpoint, token: r.token, expiresAt: new Date(r.expiresAt) };
	}

	async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
		const batch = await database.getCrudBatch(SYNC_BATCH_MAX);
		if (!batch) return;
		const clientId = await database.getClientId();
		// Chaque opération porte sa clé d'idempotence et, pour une table d'organisation, l'organisation de la ligne.
		const operations: SyncOperation[] = await toOperations(batch.crud, clientId, localOrganizationLookup(database));
		const { results } = await auth.request<SyncUploadResponse>('POST', '/sync/upload', { operations });
		const rejected = results
			.map((result, i) => ({ operation: operations[i]!, result }))
			.filter(({ result }) => result.status === 'rejected');
		if (rejected.length) await this.onRejected?.(database, rejected);
		await batch.complete();
	}
}
