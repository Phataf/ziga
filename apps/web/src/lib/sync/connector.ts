/**
 * Connecteur entre la base locale et le serveur (lot 05).
 * - fetchCredentials : jeton dédié de PowerSync, demandé à l'API (GET /sync/credentials). Hors connexion, ou si l'API
 *   ne répond pas, une erreur : PowerSync réessaiera. Seul un refus explicite de l'API (401) ferme la session, et
 *   c'est le module d'authentification qui en décide (lot 02), jamais un refus de PowerSync.
 * - uploadData : les modifications faites sur l'appareil, envoyées par lots (POST /sync/upload), chacune avec sa clé
 *   d'idempotence (base locale et numéro de l'opération). L'API répond 200 avec un résultat par opération : le lot
 *   quitte la file, et la synchronisation suivante remet la valeur du serveur là où une opération a été refusée. Une
 *   erreur passagère (réseau, 5xx) laisse le lot dans la file : PowerSync le renverra, sans doublon.
 */
import type { AbstractPowerSyncDatabase, PowerSyncBackendConnector, PowerSyncCredentials } from '@powersync/web';
import { SYNC_BATCH_MAX, type SyncOperation, type SyncOperationResult, type SyncUploadResponse } from '@ziga/shared/sync';
import { auth } from '../auth/auth.svelte';

/** Opérations refusées par le serveur, avec ce qui avait été envoyé (liste « Modifications non acceptées », étape 4). */
export type RejectionListener = (rejected: { operation: SyncOperation; result: SyncOperationResult }[]) => Promise<void> | void;

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
		const operations: SyncOperation[] = batch.crud.map((entry) => ({
			key: `${clientId}:${entry.clientId}`,
			op: entry.op,
			table: entry.table,
			id: entry.id,
			data: entry.opData ?? null
		}));
		const { results } = await auth.request<SyncUploadResponse>('POST', '/sync/upload', { operations });
		const rejected = results
			.map((result, i) => ({ operation: operations[i]!, result }))
			.filter(({ result }) => result.status === 'rejected');
		if (rejected.length) await this.onRejected?.(rejected);
		await batch.complete();
	}
}
