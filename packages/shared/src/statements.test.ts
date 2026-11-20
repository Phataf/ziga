/**
 * Relevés propriétaires (lot 10) : part du loyer et des charges (règle du cumul), éléments d'un relevé (imputations
 * sur échéance), trop-perçus, annulations, dépenses, commissions, net négatif reporté, rectificatif, rapprochement.
 */
import { describe, expect, it } from 'vitest';
import {
	allocateRentPayment,
	applyLeaseCredit,
	applyLinesToDues,
	creditByPayment,
	reverseAllocations,
	type AllocationLine,
	type DueForAllocation
} from './allocation.js';
import { addDays } from './dates.js';
import type { Commission } from './owners.js';
import {
	addMonthsToMonth,
	chargesCovered,
	computeStatement,
	daysInForce,
	monthEnd,
	monthLabel,
	monthlyFee,
	netHeadline,
	newStatementToken,
	payoutBlockers,
	percentCommission,
	splitDueLedger,
	statementDocument,
	statementHasContent,
	statementIssueBlockers,
	statementItemKey,
	statementQuotaUsed,
	statementTokenState,
	STATEMENT_TOKEN_PATTERN,
	type ConsumedItem,
	type LedgerEntry,
	type StatementAllocation,
	type StatementDue,
	type StatementExpense,
	type StatementInput,
	type StatementMandate,
	type StatementResult
} from './statements.js';

// ---------------------------------------------------------------- générateur à graine fixe

function rng(seed: number) {
	let s = seed >>> 0;
	return (n: number) => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s % n;
	};
}

// ---------------------------------------------------------------- point 1 : part du loyer et des charges

describe('part du loyer et des charges (règle du cumul)', () => {
	const due = { rent: 75_000, charges: 5_000 };
	const entries = (amounts: number[]): LedgerEntry[] =>
		amounts.map((a, i) => ({ allocationId: `a${i}`, direction: a > 0 ? 'allocate' : 'reverse', amount: Math.abs(a) }));
	const total = (m: Map<string, { rent: number; charges: number }>) =>
		[...m.values()].reduce((s, v) => ({ rent: s.rent + v.rent, charges: s.charges + v.charges }), { rent: 0, charges: 0 });

	it('trois paiements partiels qui soldent l’échéance : exactement le loyer et les charges', () => {
		const split = splitDueLedger(due, entries([33_333, 33_333, 13_334]));
		// ⌊33 333 × 5 000 / 80 000⌋ = 2 083 ; ⌊66 666 × 5 000 / 80 000⌋ = 4 166 ; 5 000.
		expect([...split.values()]).toEqual([
			{ rent: 31_250, charges: 2_083 },
			{ rent: 31_250, charges: 2_083 },
			{ rent: 12_500, charges: 834 }
		]);
		expect(total(split)).toEqual({ rent: 75_000, charges: 5_000 });
	});

	it('arrondir chaque ligne perdrait des francs ; le cumul jamais', () => {
		const amounts = Array.from({ length: 7 }, () => 11_428).concat([4]);
		const split = splitDueLedger(due, entries(amounts));
		const perLine = amounts.reduce((s, a) => s + Math.floor((a * 5_000) / 80_000), 0);
		expect(perLine).toBeLessThan(5_000);
		expect(total(split)).toEqual({ rent: 75_000, charges: 5_000 });
	});

	it('cas limites : charges nulles, échéance faite de charges seulement, 1 FCFA', () => {
		expect(total(splitDueLedger({ rent: 50_000, charges: 0 }, entries([1, 49_999])))).toEqual({ rent: 50_000, charges: 0 });
		expect(total(splitDueLedger({ rent: 0, charges: 7_000 }, entries([3_000, 4_000])))).toEqual({ rent: 0, charges: 7_000 });
		expect([...splitDueLedger({ rent: 2, charges: 1 }, entries([1, 1, 1])).values()]).toEqual([
			{ rent: 1, charges: 0 },
			{ rent: 1, charges: 0 },
			{ rent: 0, charges: 1 }
		]);
		expect(chargesCovered(80_000, due)).toBe(5_000);
	});

	it('une ligne inverse rend sa part ; le cumul reste ⌊payé × charges / dû⌋', () => {
		const split = splitDueLedger(due, entries([40_000, 25_000, -40_000, 55_000]));
		expect(split.get('a2')).toEqual({ rent: -37_500, charges: -2_500 });
		expect(total(split)).toEqual({ rent: 75_000, charges: 5_000 });
	});

	it('refuse un registre impossible (payé négatif ou au-delà du dû)', () => {
		expect(() => splitDueLedger(due, entries([-1]))).toThrow(/hors de l’échéance/);
		expect(() => splitDueLedger(due, entries([80_001]))).toThrow(/hors de l’échéance/);
	});

	it('propriété : 3 000 registres aléatoires, avec annulations, chaque part entre 0 et le montant, cumul exact', () => {
		const r = rng(20270301);
		for (let n = 0; n < 3_000; n += 1) {
			const d = { rent: r(200_000), charges: r(30_000) };
			const amountDue = d.rent + d.charges;
			if (amountDue === 0) continue;
			const list: LedgerEntry[] = [];
			const open: number[] = [];
			let paid = 0;
			while (paid < amountDue) {
				if (open.length && r(5) === 0) {
					const a = open.splice(r(open.length), 1)[0]!;
					list.push({ allocationId: `x${list.length}`, direction: 'reverse', amount: a });
					paid -= a;
				} else {
					const a = 1 + r(amountDue - paid);
					list.push({ allocationId: `x${list.length}`, direction: 'allocate', amount: a });
					open.push(a);
					paid += a;
				}
			}
			const split = splitDueLedger(d, list);
			for (const e of list) {
				const s = split.get(e.allocationId)!;
				const abs = { rent: Math.abs(s.rent), charges: Math.abs(s.charges) };
				expect(abs.rent + abs.charges).toBe(e.amount);
				expect(Math.sign(s.rent) * Math.sign(s.charges)).not.toBe(-1);
			}
			expect(total(split)).toEqual(d);
		}
	});
});

// ---------------------------------------------------------------- outils des scénarios

const pct = (rateBp: number): Commission => ({ basis: 'percent_of_collected', rateBp });
const M10: StatementMandate = { mandateId: 'm1', version: 1, commission: pct(1_000), canCollectFunds: true };
const M10_DIRECT: StatementMandate = { ...M10, mandateId: 'm2', canCollectFunds: false };

let seq = 0;
const nextId = (p: string) => `${p}${String((seq += 1)).padStart(4, '0')}`;

function a(paymentId: string, amount: number, opts: Partial<StatementAllocation> & { date: string }): StatementAllocation {
	return {
		allocationId: nextId('al'),
		paymentId,
		direction: 'allocate',
		amount,
		origin: 'payment',
		paidOn: opts.date,
		receiptNumber: `AGX-2027-${String(seq).padStart(6, '0')}`,
		mandate: M10,
		...opts
	};
}

function dueOf(id: string, unitId: string, month: string, ledger: StatementAllocation[], rent = 75_000, charges = 5_000): StatementDue {
	return {
		id,
		leaseId: `lease-${unitId}`,
		unitId,
		tenantName: unitId === 'u1' ? 'Awa Ouédraogo' : 'Issa Sawadogo',
		periodStart: `${month}-01`,
		periodEnd: monthEnd(month),
		rent,
		charges,
		ledger
	};
}

function input(month: string, over: Partial<StatementInput> = {}): StatementInput {
	return {
		month,
		units: [
			{ id: 'u1', label: 'Villa A, appartement 1' },
			{ id: 'u2', label: 'Villa A, appartement 2' }
		],
		dues: [],
		monthlyFees: [],
		operations: [],
		expenses: [],
		previous: null,
		consumed: new Set(),
		issuedMonths: [],
		depositsHeld: [],
		creditsHeld: [],
		...over
	};
}

const keys = (r: StatementResult, role?: ConsumedItem['role']) => r.consumed.filter((c) => !role || c.role === role).map((c) => c.key);

// ---------------------------------------------------------------- scénarios du prompt

describe('totaux d’un relevé', () => {
	it('loyers de plusieurs unités, paiement partiel : loyer et charges par unité, commission sur le loyer seul', () => {
		const r = computeStatement(
			input('2027-03', {
				dues: [
					dueOf('d1', 'u1', '2027-03', [a('p1', 80_000, { date: '2027-03-04' })]),
					dueOf('d2', 'u2', '2027-03', [a('p2', 40_000, { date: '2027-03-10' })], 90_000, 10_000)
				]
			})
		);
		expect(r.unitTotals).toEqual([
			{ unitId: 'u1', label: 'Villa A, appartement 1', rent: 75_000, charges: 5_000, total: 80_000, lines: 1 },
			{ unitId: 'u2', label: 'Villa A, appartement 2', rent: 36_000, charges: 4_000, total: 40_000, lines: 1 }
		]);
		// 10 % de 111 000 (loyer seul, hors charges : réponse du porteur).
		expect(r.commissions).toMatchObject([{ basis: 'percent_of_collected', base: 111_000, amount: 11_100 }]);
		expect(r.totals).toMatchObject({ collected: 120_000, commission: 11_100, net: 108_900 });
	});

	it('paiement annulé dans le mois : il n’apparaît pas du tout', () => {
		const p = a('p1', 80_000, { date: '2027-03-04' });
		const rev = a('p1', 80_000, { date: '2027-03-20', direction: 'reverse', origin: 'cancellation', paidOn: '2027-03-04' });
		const r = computeStatement(input('2027-03', { dues: [dueOf('d1', 'u1', '2027-03', [p, rev])] }));
		expect(r.rentLines).toEqual([]);
		expect(r.totals.net).toBe(0);
		expect(keys(r, 'neutralized').sort()).toEqual(
			[statementItemKey.allocation(p.allocationId), statementItemKey.allocation(rev.allocationId)].sort()
		);
	});

	it('paiement annulé après la fin du mois mais avant l’émission : n’apparaît pas non plus', () => {
		const p = a('p1', 80_000, { date: '2027-03-28' });
		const rev = a('p1', 80_000, { date: '2027-04-02', direction: 'reverse', origin: 'cancellation', paidOn: '2027-03-28' });
		const r = computeStatement(input('2027-03', { dues: [dueOf('d1', 'u1', '2027-03', [p, rev])] }));
		expect(r.rentLines).toEqual([]);
		expect(keys(r, 'neutralized')).toHaveLength(2);
	});

	it('annulation après l’émission : ligne négative sur le relevé du mois de l’annulation, l’ancien inchangé', () => {
		const p = a('p1', 80_000, { date: '2027-03-04' });
		const march = computeStatement(input('2027-03', { dues: [dueOf('d1', 'u1', '2027-03', [p])] }));
		expect(march.totals.net).toBe(72_500);
		const rev = a('p1', 80_000, { date: '2027-04-12', direction: 'reverse', origin: 'cancellation', paidOn: '2027-03-04' });
		const april = computeStatement(
			input('2027-04', {
				dues: [dueOf('d1', 'u1', '2027-03', [p, rev])],
				consumed: new Set(keys(march)),
				issuedMonths: ['2027-03']
			})
		);
		expect(april.rentLines).toMatchObject([{ origin: 'cancellation', rent: -75_000, charges: -5_000, date: '2027-04-12' }]);
		// La commission est rendue sur la même base : −7 500.
		expect(april.totals).toMatchObject({ collected: -80_000, commission: -7_500, net: -72_500 });
	});

	it('encaissement de mars confirmé après l’émission de mars : relevé suivant, avec la mention', () => {
		const late = a('p9', 80_000, { date: '2027-03-30' });
		const april = computeStatement(input('2027-04', { dues: [dueOf('d1', 'u1', '2027-03', [late])], issuedMonths: ['2027-03'] }));
		expect(april.rentLines).toMatchObject([{ late: true, lateMonthIssued: true }]);
		const doc = statementDocument(snapshot(april));
		expect(JSON.stringify(doc)).toContain('enregistré après l’émission du relevé de mars 2027');
	});

	it('un élément daté après la fin du mois attend le relevé suivant', () => {
		const r = computeStatement(input('2027-03', { dues: [dueOf('d1', 'u1', '2027-04', [a('p1', 80_000, { date: '2027-04-01' })])] }));
		expect(r.rentLines).toEqual([]);
		expect(r.consumed).toEqual([]);
	});
});

describe('trop-perçus (réponse 1 du porteur)', () => {
	it('un crédit n’entre pas à la date du paiement : information seulement, hors du net, sans commission', () => {
		const r = computeStatement(
			input('2027-03', {
				dues: [dueOf('d1', 'u1', '2027-03', [a('p1', 80_000, { date: '2027-03-04' })])],
				creditsHeld: [{ leaseId: 'lease-u1', unitId: 'u1', tenantName: 'Awa Ouédraogo', amount: 20_000 }]
			})
		);
		expect(r.totals).toMatchObject({ collected: 80_000, commission: 7_500, net: 72_500 });
		const doc = statementDocument(snapshot(r));
		expect(doc.info.find((s) => s.title === 'Trop-perçus détenus pour vos locataires')?.rows).toEqual([
			{ title: 'Villa A, appartement 1 · Awa Ouédraogo', amount: 20_000 }
		]);
	});

	it('il entre le mois où il est imputé, réparti par la règle du cumul, et c’est alors que la commission s’applique', () => {
		const credit = a('p1', 20_000, { date: '2027-04-01', origin: 'credit', paidOn: '2027-03-04' });
		const r = computeStatement(
			input('2027-04', { dues: [dueOf('d2', 'u1', '2027-04', [credit, a('p2', 60_000, { date: '2027-04-05' })])] })
		);
		expect(r.rentLines).toMatchObject([
			{ origin: 'credit', date: '2027-04-01', paidOn: '2027-03-04', rent: 18_750, charges: 1_250, late: false },
			{ origin: 'payment', rent: 56_250, charges: 3_750 }
		]);
		expect(r.totals).toMatchObject({ collected: 80_000, commission: 7_500 });
		expect(rentLabel(r, 0)).toContain('Trop-perçu du 04/03/2027, imputé le 01/04/2027');
	});

	it('l’annulation d’un paiement dont le crédit a déjà été imputé et relevé : ligne négative de la part relevée', () => {
		const credit = a('p1', 20_000, { date: '2027-04-01', origin: 'credit', paidOn: '2027-03-04' });
		const april = computeStatement(input('2027-04', { dues: [dueOf('d2', 'u1', '2027-04', [credit])] }));
		const rev = a('p1', 20_000, { date: '2027-05-03', direction: 'reverse', origin: 'cancellation', paidOn: '2027-03-04' });
		const may = computeStatement(
			input('2027-05', { dues: [dueOf('d2', 'u1', '2027-04', [credit, rev])], consumed: new Set(keys(april)), issuedMonths: ['2027-04'] })
		);
		expect(may.rentLines).toMatchObject([{ origin: 'cancellation', rent: -18_750, charges: -1_250 }]);
	});
});

describe('dépenses (règle 16)', () => {
	const exp = (over: Partial<StatementExpense>): StatementExpense => ({
		id: nextId('ex'),
		spentOn: '2027-03-12',
		cancelledOn: null,
		amount: 15_000,
		category: 'plumbing',
		description: 'Fuite sous l’évier',
		unitId: 'u1',
		propertyId: 'prop1',
		paidBy: 'organization',
		borneBy: 'owner',
		recovery: 'owner_statement',
		...over
	});

	it('supportée par le locataire ou par l’organisation : exclue ; avancée pour le propriétaire : déduite une seule fois', () => {
		const forOwner = exp({});
		const dues = [dueOf('d1', 'u1', '2027-03', [a('p1', 80_000, { date: '2027-03-04' })])];
		const expenses = [
			forOwner,
			exp({ borneBy: 'tenant', recovery: 'claimed_from_tenant' }),
			exp({ borneBy: 'tenant', recovery: 'deposit' }),
			exp({ borneBy: 'organization', recovery: 'none' }),
			exp({ paidBy: 'tenant', borneBy: 'tenant', recovery: 'none' })
		];
		const march = computeStatement(input('2027-03', { dues, expenses }));
		expect(march.expenseLines).toMatchObject([{ expenseId: forOwner.id, amount: -15_000 }]);
		expect(march.totals).toMatchObject({ expenses: -15_000, net: 80_000 - 7_500 - 15_000 });
		const april = computeStatement(input('2027-04', { dues, expenses, consumed: new Set(keys(march)), issuedMonths: ['2027-03'] }));
		expect(april.expenseLines).toEqual([]);
		expect(april.totals.net).toBe(0);
	});

	it('payée directement par le propriétaire : information, hors du net', () => {
		const r = computeStatement(input('2027-03', { expenses: [exp({ paidBy: 'owner', borneBy: 'owner', recovery: 'none' })] }));
		expect(r.totals.net).toBe(0);
		expect(r.info.ownerPaidExpenses).toHaveLength(1);
	});

	it('annulée avant d’être déduite : jamais affichée ; annulée après : rendue sur le relevé du mois de l’annulation', () => {
		const before = computeStatement(input('2027-03', { expenses: [exp({ cancelledOn: '2027-03-20' })] }));
		expect(before.expenseLines).toEqual([]);
		expect(keys(before, 'neutralized')).toHaveLength(2);

		const e = exp({});
		const march = computeStatement(input('2027-03', { expenses: [e] }));
		const cancelled = { ...e, cancelledOn: '2027-04-15' };
		const april = computeStatement(input('2027-04', { expenses: [cancelled], consumed: new Set(keys(march)), issuedMonths: ['2027-03'] }));
		expect(april.expenseLines).toMatchObject([{ kind: 'expense_cancellation', amount: 15_000, date: '2027-04-15' }]);
		expect(april.totals.net).toBe(15_000);
	});
});

describe('commissions', () => {
	it('pourcentage : arrondi vers zéro, sur le total du mois par version du mandat', () => {
		expect(percentCommission(33_333, 750)).toBe(2_499);
		expect(percentCommission(-33_333, 750)).toBe(-2_499);
		expect(percentCommission(0, 750)).toBe(0);
		const v2: StatementMandate = { ...M10, version: 2, commission: pct(800) };
		const r = computeStatement(
			input('2027-03', {
				dues: [
					dueOf('d1', 'u1', '2027-03', [a('p1', 33_333, { date: '2027-03-02' }), a('p2', 33_333, { date: '2027-03-09' })]),
					dueOf('d2', 'u2', '2027-03', [a('p3', 80_000, { date: '2027-03-20', mandate: v2 })])
				]
			})
		);
		// Version 1 : 10 % de 62 500 (deux lignes de 31 250) ; version 2 : 8 % de 75 000.
		expect(r.commissions.map((c) => [c.mandateVersion, c.base, c.amount])).toEqual([
			[1, 62_500, 6_250],
			[2, 75_000, 6_000]
		]);
	});

	it('montant fixe par mois : entier pour un mois complet, au prorata des jours le premier et le dernier mois', () => {
		expect(monthlyFee(30_000, '2027-03', '2027-01-01', null)).toEqual({ amount: 30_000, days: 31, daysInMonth: 31 });
		expect(monthlyFee(30_000, '2027-03', '2027-03-10', null)).toEqual({ amount: 21_290, days: 22, daysInMonth: 31 });
		expect(monthlyFee(30_000, '2027-02', '2026-01-01', '2027-02-14')).toEqual({ amount: 15_000, days: 14, daysInMonth: 28 });
		expect(daysInForce('2027-04', '2027-05-01', null)).toBe(0);
		const fixed: StatementMandate = { ...M10, commission: { basis: 'fixed_per_month', amount: 30_000 } };
		const fee = { month: '2027-03', mandate: fixed, inForceFrom: '2027-03-10', inForceUntil: null };
		const march = computeStatement(input('2027-03', { monthlyFees: [fee] }));
		expect(march.commissions).toMatchObject([{ basis: 'fixed_per_month', amount: 21_290, days: 22 }]);
		expect(march.totals.net).toBe(-21_290);
		// Déjà facturée : un rectificatif ne la reprend pas.
		const rect = computeStatement(input('2027-03', { monthlyFees: [fee], consumed: new Set(keys(march)) }));
		expect(rect.commissions).toEqual([]);
	});

	it('montant fixe par opération : un bail validé dans le mois sur une unité du mandat', () => {
		const letting: StatementMandate = { ...M10, commission: { basis: 'fixed_per_operation', amount: 50_000 } };
		const r = computeStatement(
			input('2027-03', {
				operations: [
					{ leaseId: 'l1', unitId: 'u1', tenantName: 'Awa Ouédraogo', validatedOn: '2027-03-15', mandate: letting },
					{ leaseId: 'l2', unitId: 'u2', tenantName: 'Issa Sawadogo', validatedOn: '2027-04-02', mandate: letting }
				]
			})
		);
		expect(r.commissions).toMatchObject([{ basis: 'fixed_per_operation', leaseId: 'l1', amount: 50_000 }]);
	});
});

describe('mandat sans encaissement par l’organisation (point 2) et net négatif reporté (réponse 6)', () => {
	it('loyers perçus par le propriétaire : information, commission due, net négatif affiché comme un solde en faveur de l’organisation', () => {
		const r = computeStatement(
			input('2027-03', { dues: [dueOf('d1', 'u1', '2027-03', [a('p1', 80_000, { date: '2027-03-04', mandate: M10_DIRECT })])] })
		);
		expect(r.totals).toMatchObject({
			collected: 0,
			rentCollectedByOwner: 75_000,
			chargesCollectedByOwner: 5_000,
			commission: 7_500,
			net: -7_500
		});
		const h = netHeadline(r.totals, 'Agence Kanazoé');
		expect(h).toMatchObject({ tone: 'owed', label: 'Solde en faveur de Agence Kanazoé', amount: 7_500 });
		expect(h.explanation).toContain('perçus directement par vous');
		const doc = statementDocument(snapshot(r));
		expect(doc.info[0]!.title).toBe('Loyers perçus directement par vous (pour information)');
	});

	it('solde négatif reporté sur trois mois, jusqu’à ce qu’il soit absorbé', () => {
		const fixed: StatementMandate = { ...M10, commission: { basis: 'fixed_per_month', amount: 30_000 }, canCollectFunds: true };
		const fee = (month: string) => ({ month, mandate: fixed, inForceFrom: '2027-01-01', inForceUntil: null });
		const consumed = new Set<string>();
		const issue = (r: StatementResult) => r.consumed.forEach((c) => consumed.add(c.key));

		const jan = computeStatement(input('2027-01', { monthlyFees: [fee('2027-01')], consumed }));
		expect(jan.totals.net).toBe(-30_000);
		issue(jan);

		const feb = computeStatement(
			input('2027-02', {
				monthlyFees: [fee('2027-02')],
				dues: [dueOf('d2', 'u1', '2027-02', [a('p2', 20_000, { date: '2027-02-10', mandate: fixed })])],
				previous: { statementId: 's-jan', month: '2027-01', version: 1, net: jan.totals.net },
				consumed
			})
		);
		expect(feb.carried).toMatchObject({ amount: -30_000, month: '2027-01' });
		expect(feb.totals.net).toBe(20_000 - 30_000 - 30_000);
		issue(feb);

		const mar = computeStatement(
			input('2027-03', {
				monthlyFees: [fee('2027-03')],
				dues: [
					dueOf(
						'd3',
						'u1',
						'2027-03',
						[a('p3', 80_000, { date: '2027-03-04', mandate: fixed }), a('p4', 80_000, { date: '2027-03-25', mandate: fixed })],
						150_000,
						10_000
					)
				],
				previous: { statementId: 's-feb', month: '2027-02', version: 1, net: feb.totals.net },
				consumed
			})
		);
		expect(mar.totals).toMatchObject({ carriedBalance: -40_000, net: 160_000 - 30_000 - 40_000 });
		expect(netHeadline(mar.totals, 'Agence').tone).toBe('payout');
		issue(mar);

		// Absorbé : rien n'est reporté sur avril ; le même solde n'est jamais reporté deux fois.
		const apr = computeStatement(
			input('2027-04', { previous: { statementId: 's-mar', month: '2027-03', version: 1, net: mar.totals.net }, consumed })
		);
		expect(apr.carried).toBeNull();
		const again = computeStatement(
			input('2027-03', { previous: { statementId: 's-feb', month: '2027-02', version: 1, net: feb.totals.net }, consumed })
		);
		expect(again.carried).toBeNull();
	});
});

describe('cautions (point 4)', () => {
	it('une caution détenue figure en information et ne change jamais le net', () => {
		const dues = [dueOf('d1', 'u1', '2027-03', [a('p1', 80_000, { date: '2027-03-04' })])];
		const without = computeStatement(input('2027-03', { dues }));
		const withDeposit = computeStatement(
			input('2027-03', {
				dues,
				depositsHeld: [{ leaseId: 'lease-u1', unitId: 'u1', tenantName: 'Awa Ouédraogo', type: 'security_deposit', balance: 150_000 }]
			})
		);
		expect(withDeposit.totals).toEqual(without.totals);
		const doc = statementDocument(snapshot(withDeposit));
		expect(doc.info.map((s) => s.title)).toContain('Cautions détenues pour vous');
	});
});

describe('caution détenue par le propriétaire (lot 10 bis, D32)', () => {
	it('loyer couvert par la caution qu’il détient : en information (« perçus directement par vous »), hors du net ; commission due', () => {
		const offset = a('p1', 80_000, { date: '2027-06-30', depositHolder: 'owner' });
		const r = computeStatement(input('2027-06', { dues: [dueOf('d1', 'u1', '2027-06', [offset])] }));
		expect(r.rentLines).toMatchObject([{ collectedBy: 'owner', rent: 75_000, charges: 5_000 }]);
		expect(r.totals).toMatchObject({ collected: 0, rentCollectedByOwner: 75_000, chargesCollectedByOwner: 5_000, commission: 7_500 });
		expect(r.totals.net).toBe(-7_500);
		// Caution détenue par l'organisation : le même loyer entre dans le net.
		const org = computeStatement(
			input('2027-06', { dues: [dueOf('d1', 'u1', '2027-06', [{ ...offset, depositHolder: 'organization' }])] })
		);
		expect(org.totals).toMatchObject({ collected: 80_000, net: 72_500 });
	});

	it('réparation avancée par l’organisation puis retenue par le propriétaire sur sa caution : déduite une fois, au mois de la retenue', () => {
		const repair: StatementExpense = {
			id: nextId('ex'),
			spentOn: '2027-06-20',
			cancelledOn: null,
			amount: 12_000,
			category: 'plumbing',
			description: 'Robinet de la douche',
			unitId: 'u1',
			propertyId: 'prop1',
			paidBy: 'organization',
			borneBy: 'tenant',
			recovery: 'deposit',
			ownerDepositRetention: { on: '2027-07-10', amount: 12_000 }
		};
		// Caution détenue par l'organisation (pas de retenue par le propriétaire) : rien sur le relevé.
		expect(computeStatement(input('2027-07', { expenses: [{ ...repair, ownerDepositRetention: null }] })).expenseLines).toEqual([]);
		expect(computeStatement(input('2027-06', { expenses: [repair] })).expenseLines).toEqual([]);
		const july = computeStatement(input('2027-07', { expenses: [repair] }));
		expect(july.expenseLines).toMatchObject([{ expenseId: repair.id, amount: -12_000, date: '2027-07-10', viaOwnerDeposit: true }]);
		expect(july.totals).toMatchObject({ expenses: -12_000, net: -12_000 });
		const august = computeStatement(input('2027-08', { expenses: [repair], consumed: new Set(keys(july)), issuedMonths: ['2027-07'] }));
		expect(august.expenseLines).toEqual([]);
		const doc = statementDocument(snapshot(july));
		expect(JSON.stringify(doc)).toContain('retenue par vous sur la caution le 10/07/2027');
	});
});

describe('rectificatif et émission', () => {
	it('le rectificatif ne reprend que ce qui n’a pas été repris ; son net est la différence', () => {
		const p1 = a('p1', 80_000, { date: '2027-03-04' });
		const v1 = computeStatement(input('2027-03', { dues: [dueOf('d1', 'u1', '2027-03', [p1])] }));
		const p2 = a('p2', 40_000, { date: '2027-03-29' });
		const v2 = computeStatement(
			input('2027-03', {
				dues: [dueOf('d1', 'u1', '2027-03', [p1]), dueOf('d2', 'u2', '2027-03', [p2])],
				consumed: new Set(keys(v1)),
				issuedMonths: ['2027-03']
			})
		);
		expect(v2.rentLines.map((l) => l.paymentId)).toEqual(['p2']);
		expect(v2.totals.net).toBe(40_000 - 3_750);
		expect(statementHasContent(v2)).toBe(true);
		expect(statementDocument(snapshot(v2, 2)).title).toBe('Relevé rectificatif n° 2 · mars 2027');
		expect(v2.revision).not.toBe(v1.revision);
	});

	it('règles d’émission : mois terminé, ordre des mois, rectificatif du dernier mois seulement et non vide, brouillon à jour', () => {
		const base = { kind: 'regular' as const, month: '2027-03', today: '2027-04-01', lastIssuedMonth: '2027-02', hasContent: true };
		expect(statementIssueBlockers(base)).toEqual([]);
		expect(statementIssueBlockers({ ...base, today: '2027-03-31' })).toEqual(['STATEMENT_PERIOD_NOT_ENDED']);
		expect(statementIssueBlockers({ ...base, lastIssuedMonth: '2027-03' })).toEqual(['STATEMENT_ALREADY_ISSUED']);
		expect(statementIssueBlockers({ ...base, lastIssuedMonth: '2027-04' })).toEqual(['STATEMENT_OUT_OF_ORDER']);
		expect(statementIssueBlockers({ ...base, kind: 'rectification', lastIssuedMonth: '2027-03' })).toEqual([]);
		expect(statementIssueBlockers({ ...base, kind: 'rectification' })).toEqual(['STATEMENT_RECTIFICATION_NOT_LATEST']);
		expect(statementIssueBlockers({ ...base, kind: 'rectification', lastIssuedMonth: '2027-03', hasContent: false })).toEqual([
			'STATEMENT_RECTIFICATION_EMPTY'
		]);
		expect(statementIssueBlockers({ ...base, expectedRevision: '0000aaaa', revision: '0000bbbb' })).toEqual(['STATEMENT_DRAFT_STALE']);
	});

	it('quota Découverte : relevés émis dans le mois civil, rectificatifs non comptés', () => {
		const issued = [
			{ issuedOn: '2027-04-01', version: 1 },
			{ issuedOn: '2027-04-02', version: 2 },
			{ issuedOn: '2027-03-30', version: 1 },
			{ issuedOn: '2027-04-03', version: 1 }
		];
		expect(statementQuotaUsed(issued, '2027-04-10')).toBe(2);
	});

	it('reversements : relevé émis, net positif, jamais au-delà du net', () => {
		const ok = {
			statementStatus: 'issued' as const,
			net: 100_000,
			alreadyPaid: 60_000,
			amount: 40_000,
			paidOn: '2027-04-05',
			today: '2027-04-05'
		};
		expect(payoutBlockers(ok)).toEqual([]);
		expect(payoutBlockers({ ...ok, amount: 40_001 })).toEqual(['PAYOUT_EXCEEDS_NET']);
		expect(payoutBlockers({ ...ok, net: -5_000 })).toEqual(['PAYOUT_NOTHING_DUE']);
		expect(payoutBlockers({ ...ok, statementStatus: 'draft', paidOn: '2027-04-06' })).toEqual([
			'STATEMENT_NOT_ISSUED',
			'PAYOUT_DATE_IN_FUTURE'
		]);
	});
});

describe('lien partagé', () => {
	it('jeton de 256 bits en base64url ; expiré à 90 jours ; révocable', () => {
		const t = newStatementToken();
		expect(t).toMatch(STATEMENT_TOKEN_PATTERN);
		expect(newStatementToken()).not.toBe(t);
		const created = new Date('2027-04-01T10:00:00Z');
		const expiresAt = new Date(created.getTime() + 90 * 86_400_000);
		expect(statementTokenState({ expiresAt, revokedAt: null }, new Date('2027-06-29T09:59:59Z'))).toBe('valid');
		expect(statementTokenState({ expiresAt, revokedAt: null }, new Date('2027-06-30T10:00:00Z'))).toBe('expired');
		expect(statementTokenState({ expiresAt, revokedAt: new Date('2027-04-02T00:00:00Z') }, new Date('2027-04-03T00:00:00Z'))).toBe(
			'revoked'
		);
	});
});

describe('document du relevé', () => {
	it('un locataire n’apparaît que par son nom : aucun numéro de téléphone', () => {
		const r = computeStatement(
			input('2027-03', {
				dues: [dueOf('d1', 'u1', '2027-03', [a('p1', 80_000, { date: '2027-03-04' })])],
				depositsHeld: [{ leaseId: 'lease-u1', unitId: 'u1', tenantName: 'Awa Ouédraogo', type: 'security_deposit', balance: 150_000 }]
			})
		);
		const text = JSON.stringify(statementDocument(snapshot(r)));
		expect(text).toContain('Awa Ouédraogo');
		// L'organisation garde son téléphone (en-tête) ; aucun autre numéro.
		expect(text.match(/\+226\s?\d/g) ?? []).toEqual(['+226 2']);
	});

	it('cadre de synthèse : jamais un montant négatif', () => {
		expect(netHeadline({ net: 0, rentCollectedByOwner: 0, chargesCollectedByOwner: 0 }, 'A')).toMatchObject({ tone: 'zero', amount: 0 });
		expect(netHeadline({ net: 12, rentCollectedByOwner: 0, chargesCollectedByOwner: 0 }, 'A')).toMatchObject({
			tone: 'payout',
			amount: 12
		});
		expect(netHeadline({ net: -12, rentCollectedByOwner: 0, chargesCollectedByOwner: 0 }, 'A')).toMatchObject({ tone: 'owed', amount: 12 });
	});

	it('libellés des mois', () => {
		expect(monthLabel('2027-08')).toBe('août 2027');
		expect(addMonthsToMonth('2027-12', 1)).toBe('2028-01');
		expect(addMonthsToMonth('2027-01', -1)).toBe('2026-12');
	});
});

function snapshot(result: StatementResult, version = 1) {
	return {
		organization: {
			name: 'Agence Kanazoé',
			address: 'Avenue Kwamé N’Krumah',
			commune: 'Ouagadougou',
			poBox: null,
			phone: '+226 25 30 00 00',
			rccm: null,
			ifu: null,
			logoId: null
		},
		owner: { displayName: 'Mariam Compaoré' },
		month: result.month,
		version,
		issuedOn: '2027-04-01',
		units: [
			{ id: 'u1', label: 'Villa A, appartement 1' },
			{ id: 'u2', label: 'Villa A, appartement 2' }
		],
		result
	};
}

function rentLabel(r: StatementResult, i: number): string {
	return JSON.stringify(statementDocument(snapshot(r)).sections[0]!.rows[i]);
}

// ---------------------------------------------------------------- rapprochement (point 3), par simulation

/**
 * Un bail de six mois simulé jour par jour avec les fonctions d'imputation du lot 09 : paiements partiels, trop-perçus,
 * confirmations tardives (après l'émission du relevé du mois), annulations jusqu'en août ; un relevé émis le 3 de chaque mois, avec
 * les seules imputations qui existent ce jour-là. Invariants, sur 400 simulations :
 * - aucun élément n'entre dans deux relevés émis ;
 * - total encaissé de tous les relevés + trop-perçus encore détenus = encaissements confirmés non annulés ;
 * - total encaissé de tous les relevés = imputations nettes sur échéance ;
 * - échéance sans annulation : la somme de ses parts relevées égale ⌊payé × charges / dû⌋ (exactement les charges
 *   une fois soldée) ;
 * - un mois sans trop-perçu, sans confirmation tardive ni annulation : encaissé du relevé = reçus valides du mois.
 */
describe('rapprochement : simulation de 400 baux', () => {
	interface SimAllocation {
		id: string;
		line: AllocationLine;
		createdOn: string;
		origin: StatementAllocation['origin'];
	}

	function simulate(seed: number) {
		const r = rng(seed);
		const rent = 50_000 + r(10) * 5_000;
		const charges = r(3) * 2_500;
		const months = ['2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06'];
		const dues: (DueForAllocation & { month: string })[] = [];
		const allocations: SimAllocation[] = [];
		const payments: {
			id: string;
			amount: number;
			paidOn: string;
			confirmOn: string;
			cancelOn: string | null;
			confirmed: boolean;
			cancelled: boolean;
			receipt: string;
		}[] = [];
		let n = 0;
		const record = (lines: AllocationLine[], day: string, origin: (l: AllocationLine) => SimAllocation['origin']) => {
			for (const line of lines)
				allocations.push({ id: `sa${String((n += 1)).padStart(5, '0')}`, line, createdOn: day, origin: origin(line) });
		};
		const credits = () => {
			const c = creditByPayment(allocations.map((x) => x.line));
			return [...c.entries()].map(([paymentId, amount]) => ({ paymentId, amount }));
		};
		const recompute = () => {
			const lines = allocations.map((x) => x.line);
			const fresh = applyLinesToDues(
				dues.map((d) => ({ ...d, amountPaid: 0 })),
				lines
			);
			fresh.forEach((d, i) => (dues[i]!.amountPaid = d.amountPaid));
		};
		// Paiements : 1 à 3 par mois, dont certains confirmés en retard ou annulés.
		for (const [i, m] of months.entries()) {
			for (let k = 0; k < 1 + r(3); k += 1) {
				const paidOn = `${m}-${String(1 + r(28)).padStart(2, '0')}`;
				const delay = r(6) === 0 ? 5 + r(10) : 0;
				const confirmOn = addDays(paidOn, delay);
				const cancelOn = r(8) === 0 ? addDays(confirmOn, 1 + r(40)) : null;
				payments.push({
					id: `p${i}${k}`,
					amount: 5_000 + r(rent + charges + 30_000),
					paidOn,
					confirmOn,
					cancelOn,
					confirmed: false,
					cancelled: false,
					receipt: `R-${i}${k}`
				});
			}
		}
		const statements: StatementResult[] = [];
		const consumed = new Set<string>();
		const issuedMonths: string[] = [];
		const mandate: StatementMandate = { mandateId: 'm1', version: 1, commission: pct(1_000), canCollectFunds: true };

		for (let day = '2027-01-01'; day <= '2027-09-05'; day = addDays(day, 1)) {
			// Émission d'une échéance le 1er du mois, puis imputation du crédit.
			const m = day.slice(0, 7);
			if (day.endsWith('-01') && months.includes(m)) {
				dues.push({ id: `d-${m}`, month: m, dueOn: `${m}-05`, periodStart: `${m}-01`, amountDue: rent + charges, amountPaid: 0 });
				record(applyLeaseCredit(credits(), dues), day, (l) => (l.target === 'rent_due' ? 'credit' : 'credit'));
				recompute();
			}
			for (const p of payments) {
				if (!p.confirmed && p.confirmOn === day) {
					p.confirmed = true;
					record(allocateRentPayment(p.id, p.amount, dues), day, () => 'payment');
					recompute();
				}
				if (p.confirmed && !p.cancelled && p.cancelOn === day) {
					p.cancelled = true;
					record(
						reverseAllocations(
							p.id,
							allocations.map((x) => x.line)
						),
						day,
						() => 'cancellation'
					);
					recompute();
				}
			}
			// Relevé du mois précédent, émis le 3.
			if (day.endsWith('-03') && day > '2027-01-31') {
				const month = addMonthsToMonth(m, -1);
				const due = (d: (typeof dues)[number]): StatementDue => ({
					id: d.id,
					leaseId: 'l1',
					unitId: 'u1',
					tenantName: 'Awa Ouédraogo',
					periodStart: d.periodStart,
					periodEnd: monthEnd(d.month),
					rent,
					charges,
					ledger: allocations
						.filter((x) => x.line.target === 'rent_due' && x.line.targetId === d.id)
						.map((x) => {
							const p = payments.find((q) => q.id === x.line.paymentId)!;
							const date = x.origin === 'payment' ? p.paidOn : x.createdOn;
							return {
								allocationId: x.id,
								paymentId: p.id,
								direction: x.line.direction,
								amount: x.line.amount,
								origin: x.origin,
								date,
								paidOn: p.paidOn,
								receiptNumber: p.receipt,
								mandate
							};
						})
				});
				const s = computeStatement(input(month, { dues: dues.map(due), consumed, issuedMonths }));
				for (const c of s.consumed) {
					expect(consumed.has(c.key), `${c.key} repris deux fois`).toBe(false);
					consumed.add(c.key);
				}
				issuedMonths.push(month);
				statements.push(s);
			}
		}
		return { statements, allocations, payments, dues, rent, charges, credits: credits() };
	}

	it('invariants du rapprochement', () => {
		let checkedMonths = 0;
		for (let seed = 1; seed <= 400; seed += 1) {
			const { statements, allocations, payments, rent, charges, credits } = simulate(seed);
			const collected = statements.reduce((s, x) => s + x.totals.collected, 0);
			const live = payments.filter((p) => p.confirmed && !p.cancelled).reduce((s, p) => s + p.amount, 0);
			const held = credits.reduce((s, c) => s + c.amount, 0);
			expect(collected + held, `graine ${seed}`).toBe(live);
			const netOnDues = allocations
				.filter((x) => x.line.target === 'rent_due')
				.reduce((s, x) => s + (x.line.direction === 'allocate' ? x.line.amount : -x.line.amount), 0);
			expect(collected).toBe(netOnDues);

			// Parts par échéance, pour les échéances qu'aucune annulation n'a touchées.
			const touched = new Set(
				allocations.filter((x) => x.line.direction === 'reverse' && x.line.target === 'rent_due').map((x) => x.line.targetId)
			);
			const lines = statements.flatMap((s) => s.rentLines);
			for (const dueId of new Set(lines.map((l) => l.rentDueId))) {
				if (touched.has(dueId)) continue;
				const own = lines.filter((l) => l.rentDueId === dueId);
				const paid = own.reduce((s, l) => s + l.rent + l.charges, 0);
				expect(own.reduce((s, l) => s + l.charges, 0)).toBe(chargesCovered(paid, { rent, charges }));
				if (paid === rent + charges) expect(own.reduce((s, l) => s + l.rent, 0)).toBe(rent);
			}

			// Mois « simples » : encaissé du relevé = reçus valides du mois.
			for (const s of statements) {
				const inMonth = payments.filter((p) => p.paidOn.startsWith(s.month));
				const simple =
					s.rentLines.every((l) => l.origin === 'payment' && !l.late) &&
					inMonth.every((p) => p.confirmOn <= addDays(monthEnd(s.month), 3) && !p.cancelOn) &&
					!allocations.some((x) => x.line.target === 'credit' && inMonth.some((p) => p.id === x.line.paymentId));
				if (!simple) continue;
				checkedMonths += 1;
				expect(s.totals.collected).toBe(inMonth.reduce((sum, p) => sum + p.amount, 0));
			}
		}
		expect(checkedMonths).toBeGreaterThan(100);
	});
});
