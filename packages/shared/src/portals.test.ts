import { describe, expect, it } from 'vitest';
import { ownerIncome, prorateFcfa, yieldPercent, type IncomeStatement } from './portals.js';

const A = '01a00000-0000-7000-8000-000000000001';
const B = '01a00000-0000-7000-8000-000000000002';

function statement(over: Partial<IncomeStatement>): IncomeStatement {
	return {
		organizationId: A,
		id: 's1',
		month: '2026-10',
		collected: 80_000,
		commission: 8_000,
		expenses: -5_000,
		net: 67_000,
		paidOut: 62_000,
		unitTotals: [{ unitId: 'u1', total: 80_000 }],
		expenseLines: [{ unitId: 'u1', amount: -5_000 }],
		...over
	};
}

describe('revenus de l’espace du propriétaire (lot 10 ter)', () => {
	it('répartition au prorata en francs entiers : la somme est exacte', () => {
		expect(prorateFcfa(10_000, [1, 1, 1])).toEqual([3_333, 3_333, 3_334]);
		expect(prorateFcfa(8_000, [80_000])).toEqual([8_000]);
		expect(prorateFcfa(1_000, [0, 0])).toEqual([0, 0]);
		expect(prorateFcfa(-5_000, [60_000, 20_000]).reduce((a, b) => a + b, 0)).toBe(-5_000);
	});

	it('rendement simple = net ÷ encaissé, deux décimales ; aucun sans encaissement', () => {
		expect(yieldPercent(67_000, 80_000)).toBe(83.75);
		expect(yieldPercent(0, 0)).toBeNull();
	});

	it('par mois et par organisation, puis par bien : commission au prorata, dépense sur son bien', () => {
		const r = ownerIncome(
			[
				statement({}),
				statement({
					organizationId: B,
					id: 's2',
					collected: 100_000,
					commission: 10_000,
					expenses: 0,
					net: 90_000,
					paidOut: 0,
					unitTotals: [
						{ unitId: 'u2', total: 75_000 },
						{ unitId: 'u3', total: 25_000 }
					],
					expenseLines: []
				})
			],
			new Map([
				['u1', 'p1'],
				['u2', 'p2'],
				['u3', 'p3']
			]),
			'2026-11'
		);
		expect(r.months).toEqual([
			{ organizationId: A, month: '2026-10', collected: 80_000, commission: 8_000, expenses: -5_000, net: 67_000, paidOut: 62_000 },
			{ organizationId: B, month: '2026-10', collected: 100_000, commission: 10_000, expenses: 0, net: 90_000, paidOut: 0 }
		]);
		expect(r.properties).toEqual([
			{ organizationId: A, propertyId: 'p1', collected: 80_000, net: 67_000, yieldPercent: 83.75 },
			{ organizationId: B, propertyId: 'p2', collected: 75_000, net: 67_500, yieldPercent: 90 },
			{ organizationId: B, propertyId: 'p3', collected: 25_000, net: 22_500, yieldPercent: 90 }
		]);
	});

	it('par bien : seulement les 12 derniers mois ; une dépense sans unité est répartie comme la commission', () => {
		const r = ownerIncome(
			[
				statement({ month: '2025-10' }),
				statement({
					id: 's3',
					month: '2026-11',
					unitTotals: [
						{ unitId: 'u1', total: 60_000 },
						{ unitId: 'u4', total: 20_000 }
					],
					expenseLines: [{ unitId: null, amount: -4_000 }]
				})
			],
			new Map([
				['u1', 'p1'],
				['u4', 'p4']
			]),
			'2026-11'
		);
		expect(r.properties).toEqual([
			{ organizationId: A, propertyId: 'p1', collected: 60_000, net: 51_000, yieldPercent: 85 },
			{ organizationId: A, propertyId: 'p4', collected: 20_000, net: 17_000, yieldPercent: 85 }
		]);
		expect(r.months.map((m) => m.month)).toEqual(['2026-11', '2025-10']);
	});
});
