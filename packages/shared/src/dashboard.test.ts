/** Tableau de bord d'accueil (lot 10) : attendu, encaissé, taux, impayés, échéances du jour. */
import { describe, expect, it } from 'vitest';
import { dashboardSummary } from './dashboard.js';
import { formatSignedFcfa, formatSignedFcfaForPdf } from './money.js';

describe('tableau de bord', () => {
	it('loyers attendus et encaissés du mois, taux d’encaissement, impayés, échéances du jour', () => {
		const s = dashboardSummary({
			today: '2027-04-05',
			dues: [
				{ id: 'a', dueOn: '2027-04-05', amountDue: 80_000, amountPaid: 80_000 },
				{ id: 'b', dueOn: '2027-04-05', amountDue: 60_000, amountPaid: 0 },
				{ id: 'c', dueOn: '2027-04-10', amountDue: 60_000, amountPaid: 20_000 },
				{ id: 'd', dueOn: '2027-03-05', amountDue: 50_000, amountPaid: 10_000 },
				{ id: 'e', dueOn: '2027-04-05', amountDue: 70_000, amountPaid: 0, waived: true }
			],
			confirmedRentPayments: [
				{ amount: 80_000, paidOn: '2027-04-02' },
				{ amount: 20_000, paidOn: '2027-03-30' },
				{ amount: 20_000, paidOn: '2027-04-04' }
			],
			statementsToIssue: 3
		});
		expect(s).toMatchObject({
			month: '2027-04',
			expected: 200_000,
			paidOnExpected: 100_000,
			collected: 100_000,
			collectionRate: 50,
			arrears: 40_000,
			arrearsCount: 1,
			statementsToIssue: 3
		});
		expect(s.dueToday.map((d) => d.id)).toEqual(['b']);
	});

	it('aucun loyer attendu : pas de taux', () => {
		expect(dashboardSummary({ today: '2027-04-05', dues: [], confirmedRentPayments: [] }).collectionRate).toBeNull();
	});
});

describe('montants signés', () => {
	it('signe moins U+2212 à l’écran, trait d’union dans un PDF', () => {
		expect(formatSignedFcfa(-15_000)).toBe('−15 000 FCFA');
		expect(formatSignedFcfa(15_000)).toBe('15 000 FCFA');
		expect(formatSignedFcfaForPdf(-15_000)).toBe('-15 000 FCFA');
		expect(() => formatSignedFcfa(1.5)).toThrow();
	});
});
