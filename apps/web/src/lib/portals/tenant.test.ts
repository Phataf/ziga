import { describe, expect, it } from 'vitest';
import {
	appendPage,
	canObserve,
	contractGroups,
	noticeCandidates,
	placeLabel,
	receiptsOf,
	sortRequests,
	type HistoryItem,
	type TenantContract,
	type TenantHome,
	type TenantRequest
} from './tenant.ts';

const org = { organizationId: 'A', organizationName: 'Agence A', organizationType: 'agency' as const, organizationPhone: '+22625300000' };

describe('espace du locataire (lot 10 ter, étape 3c)', () => {
	it('contrats : à signer, en vigueur, terminés ; groupes vides omis', () => {
		const c = (leaseId: string, group: TenantContract['group'], startsOn: string) => ({ leaseId, group, startsOn }) as TenantContract;
		const groups = contractGroups([c('1', 'ended', '2024-01-01'), c('2', 'in_force', '2026-01-01'), c('3', 'ended', '2025-01-01')]);
		expect(groups.map((g) => [g.group, g.contracts.map((x) => x.leaseId)])).toEqual([
			['in_force', ['2']],
			['ended', ['3', '1']]
		]);
	});

	it('reçus et pages d’historique sans doublon', () => {
		const i = (kind: HistoryItem['kind'], id: string, organizationId = 'A') =>
			({ ...org, organizationId, kind, id, date: '2026-01-01' }) as HistoryItem;
		expect(receiptsOf([i('lease', 'l'), i('receipt', 'r')]).map((r) => r.id)).toEqual(['r']);
		expect(appendPage([i('receipt', 'r')], [i('receipt', 'r'), i('receipt', 'r', 'B')]).map((x) => x.organizationId)).toEqual(['A', 'B']);
	});

	it('préavis seulement sur un bail en vigueur ; observation tant que le décompte est proposé', () => {
		const h = (leaseId: string, status: TenantHome['status']) => ({ leaseId, status }) as TenantHome;
		expect(noticeCandidates([h('1', 'active'), h('2', 'notice')]).map((x) => x.leaseId)).toEqual(['1']);
		expect(canObserve({ id: 's', status: 'in_correction' })).toBe(false);
		expect(canObserve(null)).toBe(false);
		expect(canObserve({ id: 's', status: 'proposed' } as never)).toBe(true);
		expect(canObserve({ id: 's', status: 'disputed' } as never)).toBe(false);
	});

	it('libellé du logement et ordre des signalements', () => {
		expect(placeLabel({ unitLabel: 'A1', propertyName: 'Immeuble' })).toBe('A1 · Immeuble');
		expect(placeLabel({ unitLabel: null, propertyName: 'Immeuble' })).toBe('Immeuble');
		const r = (id: string, status: TenantRequest['status'], createdAt: string) => ({ id, status, createdAt }) as TenantRequest;
		expect(
			sortRequests([r('a', 'done', '2026-03-01'), r('b', 'received', '2026-01-01'), r('c', 'planned', '2026-02-01')]).map((x) => x.id)
		).toEqual(['c', 'b', 'a']);
	});
});
