import { describe, expect, it } from 'vitest';
import {
	assetTotals,
	formatYield,
	incomeByMonth,
	payoutsOf,
	propertiesByYield,
	unitSituation,
	type OwnerAssetsOrganization,
	type OwnerStatement
} from './owner.ts';

const unit = (over: Partial<OwnerAssetsOrganization['properties'][number]['units'][number]>) => ({
	id: 'u',
	label: 'A1',
	type: 'apartment',
	rent: 75_000,
	charges: 5_000,
	occupancy: 'free' as const,
	technicalStatus: 'ready',
	available: true,
	lease: null,
	...over
});

describe('espace du propriétaire (lot 10 ter, étape 3b)', () => {
	it('situation d’une unité : louée, en préavis, réservée, disponible ou non (règle 13, calculée par le serveur)', () => {
		expect(unitSituation({ occupancy: 'occupied', available: false })).toBe('occupied');
		expect(unitSituation({ occupancy: 'notice', available: true })).toBe('notice');
		expect(unitSituation({ occupancy: 'reserved', available: false })).toBe('reserved');
		expect(unitSituation({ occupancy: 'free', available: true })).toBe('available');
		expect(unitSituation({ occupancy: 'free', available: false })).toBe('unavailable');
	});

	it('totaux du patrimoine, toutes organisations confondues', () => {
		const orgs = [
			{ properties: [{ units: [unit({ occupancy: 'occupied' }), unit({})] }] },
			{ properties: [{ units: [unit({ occupancy: 'notice' })] }, { units: [] }] }
		] as unknown as OwnerAssetsOrganization[];
		expect(assetTotals(orgs)).toEqual({ properties: 3, units: 3, let: 2 });
	});

	it('revenus par mois, organisations additionnées, le plus récent d’abord ; biens par rendement', () => {
		const m = (organizationId: string, month: string, net: number) => ({
			organizationId,
			month,
			collected: net,
			commission: 0,
			expenses: 0,
			net,
			paidOut: 0
		});
		expect(incomeByMonth([m('A', '2026-09', 10), m('B', '2026-10', 20), m('A', '2026-10', 5)]).map((r) => [r.month, r.net])).toEqual([
			['2026-10', 25],
			['2026-09', 10]
		]);
		const p = (propertyId: string, yieldPercent: number | null) => ({
			organizationId: 'A',
			propertyId,
			collected: 1,
			net: 1,
			yieldPercent
		});
		expect(propertiesByYield([p('x', null), p('y', 80), p('z', 90)]).map((r) => r.propertyId)).toEqual(['z', 'y', 'x']);
	});

	it('reversements de tous les relevés, du plus récent au plus ancien ; contre-écriture négative', () => {
		const st = (id: string, payouts: OwnerStatement['payouts']) =>
			({ id, organizationId: 'A', organizationName: 'Agence', month: '2026-10', payouts }) as unknown as OwnerStatement;
		const rows = payoutsOf([
			st('s1', [{ id: 'p1', kind: 'payout', amount: 60_000, paidOn: '2026-11-05', method: 'mobile_money' }]),
			st('s2', [{ id: 'p2', kind: 'reversal', amount: 60_000, paidOn: '2026-11-06', method: 'mobile_money' }])
		]);
		expect(rows.map((r) => [r.id, r.signedAmount])).toEqual([
			['p2', -60_000],
			['p1', 60_000]
		]);
	});

	it('rendement en français', () => {
		expect(formatYield(87.5)).toBe('87,5\u202f%');
		expect(formatYield(100)).toBe('100\u202f%');
	});
});
