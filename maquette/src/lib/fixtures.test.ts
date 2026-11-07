import { describe, expect, it } from 'vitest';
import { buildDataset } from './fixtures';
import { arrears, collectList, monthStats, ownerStatement } from './views';

const data = buildDataset('2026-11-07');

describe('données de démonstration', () => {
	it('respecte le volume demandé par le lot 00', () => {
		expect(data.properties).toHaveLength(12);
		expect(data.units).toHaveLength(20);
		expect(data.tenants).toHaveLength(15);
		expect(new Set(data.dues.map((d) => d.period))).toEqual(new Set(['2026-09', '2026-10', '2026-11']));
		expect(new Set(data.properties.map((p) => p.city))).toEqual(new Set(['Ouagadougou', 'Saaba']));
	});

	it('n’a qu’un bail par unité, et seulement sur des unités louées', () => {
		const unitIds = data.leases.map((l) => l.unitId);
		expect(new Set(unitIds).size).toBe(unitIds.length);
		for (const id of unitIds) expect(data.units.find((u) => u.id === id)?.status).toBe('rented');
	});

	it('n’utilise que des montants entiers', () => {
		for (const x of [...data.dues, ...data.payments, ...data.expenses]) expect(Number.isSafeInteger(x.amount)).toBe(true);
	});

	it('contient des impayés, un paiement partiel et deux échéances du jour', () => {
		const late = arrears(data);
		expect(late.length).toBeGreaterThanOrEqual(3);
		expect(late[0].tenant.name).toBe('Rodrigue Yaméogo');
		expect(late.some((v) => v.overdueDues.some((d) => d.paid > 0))).toBe(true);
		expect(monthStats(data).dueToday).toHaveLength(2);
	});

	it('numérote les reçus sans trou', () => {
		const numbers = data.payments.map((p) => Number(p.receiptNumber.split('-')[2])).sort((a, b) => a - b);
		numbers.forEach((n, i) => expect(n).toBe(numbers[0] + i));
	});

	it('n’impute jamais plus que le montant payé', () => {
		for (const p of data.payments) {
			expect(p.allocations.reduce((s, a) => s + a.amount, 0)).toBeLessThanOrEqual(p.amount);
		}
	});

	it('trie la liste d’encaissement par solde dû', () => {
		const list = collectList(data);
		expect(list[0].balanceDue).toBeGreaterThanOrEqual(list[1].balanceDue);
	});

	it('produit un relevé propriétaire cohérent', () => {
		const st = ownerStatement(data, 'o1', '2026-10')!;
		expect(st.lines.length).toBeGreaterThan(0);
		expect(st.totals.net).toBe(st.totals.received - st.totals.commission - st.totals.expenses);
	});

	it('reste valable en fin et en début de mois', () => {
		for (const day of ['2026-12-31', '2027-01-01', '2027-02-28']) {
			const d = buildDataset(day);
			expect(monthStats(d).dueToday.length).toBeGreaterThanOrEqual(2);
			expect(d.payments.every((p) => p.date <= day)).toBe(true);
		}
	});
});
