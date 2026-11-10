import { describe, expect, it } from 'vitest';
import { currentMandate, expiringMandates, normalize, searchOwners, toMandate, toOwner, toVersion } from './views';

const today = '2026-11-10';

describe('propriétaires et mandats lus sur l’appareil (lot 06)', () => {
	it('fiche : représentant d’un groupe, statut actif par défaut (création pas encore synchronisée)', () => {
		const o = toOwner({
			id: 'o1',
			type: 'group',
			name: 'Héritiers Kaboré',
			phone: '+22670112233',
			country: 'BF',
			representative_name: 'Paul Kaboré',
			representative_phone: '+22676000001',
			status: null
		});
		expect(o).toMatchObject({
			type: 'group',
			status: 'active',
			representative: { name: 'Paul Kaboré', phone: '+22676000001' },
			email: null
		});
		expect(toOwner({ id: 'o2', type: 'person', name: 'X', phone: '+226', status: 'archived' }).status).toBe('archived');
	});

	it('mandat : booléens 0 ou 1, commission en colonnes, version 1 par défaut', () => {
		const m = toMandate({
			id: 'm1',
			owner_id: 'o1',
			type: 'rental_management',
			starts_on: '2026-01-01',
			ends_on: null,
			commission_basis: 'percent_of_collected',
			commission_rate_bp: 1000,
			commission_amount: null,
			can_publish: 1,
			can_take_photos: 0,
			can_collect_funds: 1,
			can_sign_leases: 0,
			exclusive: 0,
			status: 'active',
			version: null
		});
		expect(m).toMatchObject({
			commission: { basis: 'percent_of_collected', rateBp: 1000 },
			canPublish: true,
			canTakePhotos: false,
			canCollectFunds: true,
			version: 1
		});
		const v = toVersion({
			mandate_id: 'm1',
			version: 2,
			starts_on: '2026-01-01',
			commission_basis: 'fixed_per_month',
			commission_amount: 25000,
			status: 'revoked',
			revocation_reason: 'Fin'
		});
		expect(v).toMatchObject({
			version: 2,
			commission: { basis: 'fixed_per_month', amount: 25000 },
			status: 'revoked',
			revocationReason: 'Fin'
		});
	});

	it('recherche : nom sans accents ni majuscules, ou chiffres du téléphone', () => {
		const owners = [
			{ name: 'Issa Ouédraogo', phone: '+22670112233' },
			{ name: 'Awa Traoré', phone: '+33612345678' }
		];
		expect(normalize(' ÉLÉONORE ')).toBe('eleonore');
		expect(searchOwners(owners, 'ouedraogo').map((o) => o.name)).toEqual(['Issa Ouédraogo']);
		expect(searchOwners(owners, 'TRAORE').map((o) => o.name)).toEqual(['Awa Traoré']);
		expect(searchOwners(owners, '70 11').map((o) => o.name)).toEqual(['Issa Ouédraogo']);
		expect(searchOwners(owners, '')).toHaveLength(2);
		expect(searchOwners(owners, 'zzz')).toEqual([]);
	});

	it('mandat en vigueur : la gestion d’abord ; sinon un mandat à venir ; jamais un mandat fermé', () => {
		const ms = [
			{ id: 'a', type: 'letting', status: 'active', startsOn: '2026-01-01', endsOn: null },
			{ id: 'b', type: 'rental_management', status: 'active', startsOn: '2026-01-01', endsOn: null },
			{ id: 'c', type: 'rental_management', status: 'revoked', startsOn: '2025-01-01', endsOn: null }
		] as const;
		expect(currentMandate([...ms], today)?.id).toBe('b');
		expect(currentMandate([ms[2]], today)).toBeNull();
		expect(
			currentMandate([{ id: 'd', type: 'rental_management', status: 'active', startsOn: '2027-01-01', endsOn: null }], today)?.id
		).toBe('d');
		// Fin passée, même avant la tâche de nuit : plus en vigueur.
		expect(
			currentMandate([{ id: 'e', type: 'rental_management', status: 'active', startsOn: '2026-01-01', endsOn: '2026-11-09' }], today)
		).toBeNull();
	});

	it('alerte : mandats en vigueur qui finissent dans 30 jours ou moins, les plus proches d’abord', () => {
		const ms = [
			{ id: 'loin', ownerId: 'o', status: 'active', startsOn: '2026-01-01', endsOn: '2026-12-31' },
			{ id: 'proche', ownerId: 'o', status: 'active', startsOn: '2026-01-01', endsOn: '2026-11-15' },
			{ id: 'j30', ownerId: 'o', status: 'active', startsOn: '2026-01-01', endsOn: '2026-12-10' },
			{ id: 'revoque', ownerId: 'o', status: 'revoked', startsOn: '2026-01-01', endsOn: '2026-11-20' },
			{ id: 'fini', ownerId: 'o', status: 'active', startsOn: '2026-01-01', endsOn: '2026-11-01' }
		] as const;
		expect(expiringMandates([...ms], today)).toEqual([
			{ mandateId: 'proche', ownerId: 'o', endsOn: '2026-11-15', daysLeft: 5 },
			{ mandateId: 'j30', ownerId: 'o', endsOn: '2026-12-10', daysLeft: 30 }
		]);
	});
});
