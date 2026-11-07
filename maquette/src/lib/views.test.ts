import { describe, expect, it } from 'vitest';
import { buildDataset } from './fixtures';
import { scopeDataset } from './views';

describe('scopeDataset', () => {
	const data = buildDataset('2026-11-07');

	it('ne garde que les biens demandés et tout ce qui en dépend', () => {
		const s = scopeDataset(data, { propertyIds: ['p3', 'p4'] });
		expect(s.properties.map((p) => p.id)).toEqual(['p3', 'p4']);
		const unitIds = new Set(s.units.map((u) => u.id));
		expect(s.units.every((u) => ['p3', 'p4'].includes(u.propertyId))).toBe(true);
		expect(s.leases.every((l) => unitIds.has(l.unitId))).toBe(true);
		const leaseIds = new Set(s.leases.map((l) => l.id));
		expect(s.payments.every((p) => leaseIds.has(p.leaseId))).toBe(true);
		expect(s.dues.every((d) => leaseIds.has(d.leaseId))).toBe(true);
		expect(s.owners.map((o) => o.id)).toEqual(['o2']);
	});

	it('pour un locataire, ne garde que son bail, son unité et ses paiements', () => {
		const lease = data.leases[0];
		const s = scopeDataset(data, { leaseId: lease.id });
		expect(s.leases).toHaveLength(1);
		expect(s.units.map((u) => u.id)).toEqual([lease.unitId]);
		expect(s.tenants.map((t) => t.id)).toEqual([lease.tenantId]);
		expect(s.payments.every((p) => p.leaseId === lease.id)).toBe(true);
		expect(s.expenses).toHaveLength(0);
	});

	it('sans périmètre, renvoie les données telles quelles', () => {
		expect(scopeDataset(data, {})).toBe(data);
	});
});
