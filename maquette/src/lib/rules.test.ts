import { describe, expect, it } from 'vitest';
import { allocateOldestFirst, commissionOf, dueStates, initialStatus, publicationBlockers, statementTotals } from './rules';
import type { Mandate, Payment, RentDue, Unit } from './types';

const dues: RentDue[] = [
	{ id: 'd-nov', leaseId: 'l', period: '2026-11', dueDate: '2026-11-05', amount: 40000 },
	{ id: 'd-sep', leaseId: 'l', period: '2026-09', dueDate: '2026-09-05', amount: 40000 },
	{ id: 'd-oct', leaseId: 'l', period: '2026-10', dueDate: '2026-10-05', amount: 40000 }
];

describe('imputation sur l’échéance la plus ancienne', () => {
	it('solde d’abord la plus ancienne, puis la suivante', () => {
		const states = dueStates(dues, []);
		const { allocations, advance } = allocateOldestFirst(60000, states);
		expect(allocations).toEqual([
			{ rentDueId: 'd-sep', period: '2026-09', amount: 40000 },
			{ rentDueId: 'd-oct', period: '2026-10', amount: 20000 }
		]);
		expect(advance).toBe(0);
	});

	it('tient compte d’un paiement partiel déjà imputé', () => {
		const partial: Payment = {
			id: 'p1',
			leaseId: 'l',
			date: '2026-09-06',
			amount: 50000,
			method: 'cash',
			status: 'validated',
			receiptNumber: 'R-1',
			allocations: [
				{ rentDueId: 'd-sep', period: '2026-09', amount: 40000 },
				{ rentDueId: 'd-oct', period: '2026-10', amount: 10000 }
			]
		};
		const states = dueStates(dues, [partial]);
		expect(states.map((s) => s.balance)).toEqual([0, 30000, 40000]);
		const { allocations } = allocateOldestFirst(30000, states);
		expect(allocations).toEqual([{ rentDueId: 'd-oct', period: '2026-10', amount: 30000 }]);
	});

	it('ne dépasse jamais le montant payé et garde l’excédent en avance', () => {
		const { allocations, advance } = allocateOldestFirst(130000, dueStates(dues, []));
		expect(allocations.reduce((s, a) => s + a.amount, 0)).toBe(120000);
		expect(advance).toBe(10000);
	});

	it('refuse un montant nul, négatif ou à virgule', () => {
		const states = dueStates(dues, []);
		expect(() => allocateOldestFirst(0, states)).toThrow();
		expect(() => allocateOldestFirst(-5, states)).toThrow();
		expect(() => allocateOldestFirst(1000.5, states)).toThrow();
	});
});

describe('statut initial d’un paiement', () => {
	it('Mobile Money déclaré → à rapprocher', () => {
		expect(initialStatus('orange_money')).toBe('to_reconcile');
		expect(initialStatus('moov_money')).toBe('to_reconcile');
	});
	it('espèces saisies par le gestionnaire → validé', () => {
		expect(initialStatus('cash')).toBe('validated');
	});
});

describe('conditions de publication', () => {
	const mandate: Mandate = {
		id: 'm',
		ownerId: 'o',
		type: 'management',
		startDate: '2025-01-01',
		endDate: '2027-12-31',
		commissionRate: 10,
		canPublish: true,
		canPhotograph: true,
		canCollect: true
	};
	const unit: Unit = {
		id: 'u',
		propertyId: 'p',
		label: 'App. 1',
		kind: 'Appartement',
		rooms: 3,
		surface: 80,
		rent: 110000,
		charges: 0,
		status: 'free',
		photos: 5,
		features: [],
		description: '',
		visibility: 'internal'
	};
	const today = '2026-11-07';

	it('autorise une unité libre, sous mandat actif, avec 3 photos et un loyer', () => {
		expect(publicationBlockers(unit, mandate, today)).toEqual([]);
	});
	it('refuse une unité louée', () => {
		expect(publicationBlockers({ ...unit, status: 'rented' }, mandate, today)).toContain('L’unité est louée.');
	});
	it('refuse sans autorisation de publier dans le mandat', () => {
		expect(publicationBlockers(unit, { ...mandate, canPublish: false }, today)).toContain(
			'Le mandat n’autorise pas la publication.'
		);
	});
	it('refuse un mandat expiré', () => {
		expect(publicationBlockers(unit, { ...mandate, endDate: '2026-10-31' }, today)).toContain(
			'Le mandat n’est pas actif.'
		);
	});
	it('refuse avec moins de 3 photos ou sans loyer', () => {
		const reasons = publicationBlockers({ ...unit, photos: 2, rent: 0 }, mandate, today);
		expect(reasons).toHaveLength(2);
	});
});

describe('relevé propriétaire', () => {
	it('calcule le net à reverser en entiers', () => {
		const lines = [
			{ amount: 85000, commission: commissionOf(85000, 10) },
			{ amount: 37500, commission: commissionOf(37500, 8) }
		];
		const totals = statementTotals(lines, [{ amount: 25000 }]);
		expect(totals).toEqual({ received: 122500, commission: 11500, expenses: 25000, net: 86000 });
		expect(Number.isInteger(totals.net)).toBe(true);
	});
});
