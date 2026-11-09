import { describe, expect, it } from 'vitest';
import { syncState } from './status';

const base = { online: true, connected: true, hasSynced: true, downloading: false, pending: 0 };

describe('état de la synchronisation dans l’en-tête (lot 05)', () => {
	it('« À jour » une fois synchronisé, sans rien à envoyer', () => expect(syncState(base)).toBe('up_to_date'));
	it('« Hors ligne » sans réseau, même avec des modifications en attente', () =>
		expect(syncState({ ...base, online: false, pending: 3 })).toBe('offline'));
	it('« Hors ligne » quand la connexion au service tombe après une première synchronisation', () =>
		expect(syncState({ ...base, connected: false })).toBe('offline'));
	it('« N modifications en attente » tant que l’envoi n’est pas fait', () => expect(syncState({ ...base, pending: 2 })).toBe('pending'));
	it('première synchronisation en cours', () => {
		expect(syncState({ ...base, hasSynced: false, connected: false })).toBe('starting');
		expect(syncState({ ...base, hasSynced: false })).toBe('syncing');
	});
});
