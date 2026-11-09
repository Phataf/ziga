/**
 * État de la synchronisation montré dans l'en-tête (lot 05) : une règle pure, testée sans navigateur.
 * « Hors ligne » l'emporte ; puis les modifications en attente d'envoi ; puis la première synchronisation.
 */
export type SyncState = 'starting' | 'up_to_date' | 'offline' | 'pending' | 'syncing';

export interface SyncSnapshot {
	online: boolean;
	connected: boolean;
	hasSynced: boolean;
	downloading: boolean;
	pending: number;
}

export function syncState(s: SyncSnapshot): SyncState {
	if (!s.online || (!s.connected && s.hasSynced)) return 'offline';
	if (s.pending > 0) return 'pending';
	if (!s.hasSynced) return s.connected ? 'syncing' : 'starting';
	return s.downloading ? 'syncing' : 'up_to_date';
}
