/** Organisation active (lot 03) : jamais deux à la fois, jamais celle d'une autre personne. */
import { describe, expect, it } from 'vitest';
import type { MembershipView } from '@ziga/shared/organizations';
import { clearMemberships, MEMBERSHIPS_KEY, pickActive, readMemberships, writeMemberships } from './memberships';

const m = (id: string, type: 'agency' | 'landlord' = 'agency'): MembershipView => ({
	organizationId: id,
	type,
	name: id,
	role: 'director',
	verificationStatus: 'pending'
});

function memoryStore() {
	const map = new Map<string, string>();
	return {
		map,
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k)
	};
}

describe('organisation active', () => {
	it('garde le choix s’il est encore valable', () => {
		expect(pickActive([m('a'), m('b')], 'b')).toBe('b');
	});

	it('une seule organisation : elle est active d’office', () => {
		expect(pickActive([m('a')], null)).toBe('a');
		expect(pickActive([m('a')], 'retiree')).toBe('a');
	});

	it('plusieurs sans choix valable : aucune (la personne choisit)', () => {
		expect(pickActive([m('a'), m('b')], null)).toBeNull();
		expect(pickActive([m('a'), m('b')], 'retiree')).toBeNull();
		expect(pickActive([], 'a')).toBeNull();
	});
});

describe('appartenances gardées sur l’appareil', () => {
	it('sont relues pour la même personne seulement', () => {
		const store = memoryStore();
		writeMemberships(store, { userId: 'u1', memberships: [m('a')], activeId: 'a' });
		expect(readMemberships(store, 'u1')?.activeId).toBe('a');
		expect(readMemberships(store, 'u2')).toBeNull();
	});

	it('effacées à la déconnexion ; une valeur illisible est ignorée', () => {
		const store = memoryStore();
		writeMemberships(store, { userId: 'u1', memberships: [m('a')], activeId: 'a' });
		clearMemberships(store);
		expect(store.map.has(MEMBERSHIPS_KEY)).toBe(false);
		store.setItem(MEMBERSHIPS_KEY, '{pas du json');
		expect(readMemberships(store, 'u1')).toBeNull();
	});
});
