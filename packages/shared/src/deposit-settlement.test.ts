/**
 * Décompte de sortie (lot 10 bis, D15, D32, règle 14), en fonction pure, testé avant toute table. Tests attendus par le
 * prompt : exemple du porteur, caution imputée sur les loyers puis dégâts, réparation du locataire non vérifiée,
 * impayés supérieurs à la caution, propriété « total des sorties ≤ caution reçue » ; retenue sans ligne tenant_damage,
 * sans montant ou sans justificatif refusée ; imputation sans accord ou accord daté après les mois refusée. Points du
 * porteur : trop-perçu (a), dépense réclamée jamais comptée deux fois (b).
 */
import { describe, expect, it } from 'vitest';
import {
	agreementPlan,
	canTransitionSettlement,
	computeSettlement,
	refundAlert,
	refundDeadline,
	rentApplicationBlocker,
	SETTLEMENT_STATUSES,
	settlementLineBlocker,
	settlementMovements,
	type ExpenseDebtLine,
	type RentByAgreementLine,
	type RepairLine,
	type SettlementInput,
	type SettlementLine,
	type UnpaidRentLine
} from './deposit-settlement.js';

const EXIT = '2027-06-30';
let n = 0;
const id = (p: string) => `${p}-${++n}`;

function repair(amount: number, extra: Partial<RepairLine> = {}): RepairLine {
	return {
		id: id('repair'),
		kind: 'repair',
		inspectionItemId: id('item'),
		finding: 'tenant_damage',
		repairId: id('r'),
		performedBy: 'organization',
		status: 'planned',
		estimatedAmount: amount,
		quoteDocumentId: id('devis'),
		actualAmount: null,
		invoiceDocumentId: null,
		selfRepairAgreed: false,
		expenseId: null,
		...extra
	};
}

function unpaid(outstanding: number, periodStart = '2027-06-01'): UnpaidRentLine {
	return { id: id('due'), kind: 'unpaid_rent', rentDueId: id('rd'), periodStart, outstanding };
}

function claim(outstanding: number, extra: Partial<ExpenseDebtLine> = {}): ExpenseDebtLine {
	return {
		id: id('exp'),
		kind: 'expense_claim',
		expenseId: id('e'),
		category: 'plumbing',
		recovery: 'claimed_from_tenant',
		status: 'recorded',
		documentId: id('doc'),
		outstanding,
		...extra
	};
}

function byAgreement(periodStart: string, amount: number, extra: Partial<RentByAgreementLine> = {}): RentByAgreementLine {
	return {
		id: id('agr'),
		kind: 'rent_by_agreement',
		rentDueId: id('rd'),
		periodStart,
		amount,
		agreementId: 'accord-1',
		agreementType: 'deposit_applied_to_rent',
		agreementStatus: 'accepted',
		agreementAcceptedOn: '2027-03-20',
		agreementMonths: ['2027-04-01', '2027-05-01', '2027-06-01'],
		executed: true,
		...extra
	};
}

function input(lines: SettlementLine[], extra: Partial<SettlementInput> = {}): SettlementInput {
	return { accountType: 'security_deposit', received: 100_000, alreadyRefunded: 0, credit: 0, exitOn: EXIT, lines, ...extra };
}

describe('décompte de sortie', () => {
	it('exemple du porteur : caution 100 000, douche 10 000, porte 5 000 → deux lignes justifiées, 85 000 restitués', () => {
		const shower = repair(10_000);
		const door = repair(5_000);
		const r = computeSettlement(input([shower, door]));
		expect(r.lines.map((l) => [l.amount, l.covered, l.blocker])).toEqual([
			[10_000, 10_000, null],
			[5_000, 5_000, null]
		]);
		expect(r).toMatchObject({ deductions: 15_000, refund: 85_000, claim: 0, outcome: 'refund' });
		const moves = settlementMovements(input([shower, door]));
		expect(moves.map((m) => [m.type, m.amount])).toEqual([
			['retained', 10_000],
			['retained', 5_000],
			['refunded', 85_000]
		]);
		expect(moves[0]).toMatchObject({ inspectionItemId: shower.inspectionItemId, documentId: shower.quoteDocumentId });
	});

	it('facture plutôt que devis une fois la réparation faite, avec son justificatif', () => {
		const r = repair(10_000, { status: 'done', actualAmount: 12_000, invoiceDocumentId: 'facture' });
		expect(computeSettlement(input([r])).refund).toBe(88_000);
		expect(settlementMovements(input([r]))[0]).toMatchObject({ type: 'retained', amount: 12_000, documentId: 'facture' });
	});

	it('caution entièrement imputée sur les derniers loyers, puis des dégâts : complément réclamé', () => {
		const months = [byAgreement('2027-05-01', 50_000), byAgreement('2027-06-01', 50_000)];
		const r = computeSettlement(input([...months, repair(20_000)]));
		expect(r).toMatchObject({ coveredByDeposit: 100_000, refund: 0, claim: 20_000, outcome: 'claim' });
		expect(r.lines.at(-1)).toMatchObject({ amount: 20_000, covered: 0, uncovered: 20_000 });
		// Les mois déjà imputés ne sont pas réécrits ; seul le complément l'est.
		expect(settlementMovements(input([...months, repair(20_000)])).map((m) => [m.type, m.amount])).toEqual([
			['additional_claimed', 20_000]
		]);
	});

	it('réparation faite par le locataire : retirée seulement après contre-visite, sur accord accepté', () => {
		const declared = repair(10_000, { performedBy: 'tenant', status: 'done', selfRepairAgreed: true });
		expect(computeSettlement(input([declared])).refund).toBe(90_000);
		const verified = { ...declared, status: 'verified' as const };
		const r = computeSettlement(input([verified]));
		expect(r.refund).toBe(100_000);
		expect(r.lines[0]).toMatchObject({ amount: 0, blocker: null });
		expect(settlementMovements(input([verified])).map((m) => m.type)).toEqual(['refunded']);
		// Sans accord accepté, la contre-visite ne suffit pas : la retenue au devis reste.
		expect(computeSettlement(input([{ ...verified, selfRepairAgreed: false }])).refund).toBe(90_000);
	});

	it('impayés supérieurs à la caution : complément réclamé ; les échéances non couvertes restent dues', () => {
		const lines = [unpaid(80_000, '2027-05-01'), unpaid(80_000, '2027-06-01')];
		const r = computeSettlement(input(lines));
		expect(r).toMatchObject({ refund: 0, claim: 60_000, outcome: 'claim' });
		expect(r.lines.map((l) => [l.covered, l.uncovered])).toEqual([
			[80_000, 0],
			[20_000, 60_000]
		]);
		expect(settlementMovements(input(lines)).map((m) => [m.type, m.amount, m.target])).toEqual([
			['applied_to_debt', 80_000, { rentDueId: lines[0]!.rentDueId }],
			['applied_to_debt', 20_000, { rentDueId: lines[1]!.rentDueId }],
			['additional_claimed', 60_000, null]
		]);
	});

	it('ordre de couverture : accord, réparations, dépenses, puis loyers', () => {
		const rent = unpaid(50_000);
		const exp = claim(30_000);
		const fix = repair(40_000);
		const r = computeSettlement(input([rent, exp, fix]));
		expect(r.lines.map((l) => [l.kind, l.covered])).toEqual([
			['unpaid_rent', 30_000],
			['expense_claim', 30_000],
			['repair', 40_000]
		]);
		expect(r.claim).toBe(20_000);
	});

	it('point a : le trop-perçu s’ajoute à la restitution, ou réduit le complément', () => {
		expect(computeSettlement(input([repair(10_000)], { credit: 7_000 }))).toMatchObject({
			refund: 97_000,
			refundFromDeposit: 90_000,
			refundFromCredit: 7_000,
			claim: 0
		});
		expect(computeSettlement(input([repair(130_000)], { credit: 7_000 }))).toMatchObject({
			refund: 0,
			creditUsed: 7_000,
			claim: 23_000,
			outcome: 'claim'
		});
		// Le trop-perçu ne sort jamais du compte de caution.
		expect(settlementMovements(input([repair(10_000)], { credit: 7_000 })).find((m) => m.type === 'refunded')?.amount).toBe(90_000);
		// La garantie des factures ne prend pas le trop-perçu (il est compté une fois, sur la caution).
		expect(computeSettlement({ ...input([], { credit: 7_000 }), accountType: 'utilities_guarantee', received: 20_000 }).refund).toBe(
			20_000
		);
	});

	it('point b : une dépense réclamée est retenue pour son seul reste dû, une fois, en renvoyant à la dépense', () => {
		const exp = claim(15_000);
		const r = computeSettlement(input([exp]));
		expect(r.refund).toBe(85_000);
		const [m] = settlementMovements(input([exp]));
		expect(m).toMatchObject({ type: 'applied_to_debt', amount: 15_000, target: { expenseId: exp.expenseId }, documentId: exp.documentId });
		// Déjà remboursée (relance payée) : plus rien à retenir.
		expect(computeSettlement(input([{ ...exp, outstanding: 0 }])).lines[0]!.blocker).toBe('DEBT_NOTHING_DUE');
		// Sans justificatif : refusée.
		expect(computeSettlement(input([{ ...exp, documentId: null }])).lines[0]!.blocker).toBe('DEBT_PROOF_MISSING');
		// Une dépense à récupérer autrement (relevé, aucune) ou annulée n'est pas une somme due par le locataire.
		expect(settlementLineBlocker({ ...exp, recovery: 'owner_statement' }, { accountType: 'security_deposit', exitOn: EXIT })).toBe(
			'DEBT_NOT_CLAIMED'
		);
		expect(settlementLineBlocker({ ...exp, status: 'cancelled' }, { accountType: 'security_deposit', exitOn: EXIT })).toBe(
			'DEBT_NOT_CLAIMED'
		);
	});

	it('règle 14 : retenue sans ligne tenant_damage, sans montant ou sans justificatif refusée, et non comptée', () => {
		const ctx = { accountType: 'security_deposit' as const, exitOn: EXIT };
		expect(settlementLineBlocker(repair(10_000, { finding: 'normal_wear' }), ctx)).toBe('RETENTION_NOT_TENANT_DAMAGE');
		expect(settlementLineBlocker(repair(10_000, { finding: 'landlord_defect' }), ctx)).toBe('RETENTION_NOT_TENANT_DAMAGE');
		expect(settlementLineBlocker(repair(10_000, { inspectionItemId: null }), ctx)).toBe('RETENTION_NOT_TENANT_DAMAGE');
		expect(settlementLineBlocker(repair(0), ctx)).toBe('RETENTION_AMOUNT_MISSING');
		expect(settlementLineBlocker(repair(10_000, { estimatedAmount: null }), ctx)).toBe('RETENTION_AMOUNT_MISSING');
		expect(settlementLineBlocker(repair(10_000, { quoteDocumentId: null }), ctx)).toBe('RETENTION_PROOF_MISSING');
		// Facture saisie sans son document : on retombe sur le devis et son justificatif.
		expect(settlementLineBlocker(repair(10_000, { actualAmount: 12_000, invoiceDocumentId: null }), ctx)).toBeNull();
		const r = computeSettlement(input([repair(10_000, { quoteDocumentId: null }), repair(5_000)]));
		expect(r).toMatchObject({ deductions: 5_000, refund: 95_000 });
		expect(r.lines[0]).toMatchObject({ amount: 0, covered: 0, blocker: 'RETENTION_PROOF_MISSING' });
	});

	it('imputation sur loyer sans accord accepté, ou accord daté après les mois concernés : refusée', () => {
		const ctx = { accountType: 'security_deposit' as const, exitOn: EXIT };
		expect(settlementLineBlocker(byAgreement('2027-06-01', 50_000), ctx)).toBeNull();
		expect(settlementLineBlocker(byAgreement('2027-06-01', 50_000, { agreementId: null }), ctx)).toBe('AGREEMENT_MISSING');
		expect(settlementLineBlocker(byAgreement('2027-06-01', 50_000, { agreementType: 'tenant_self_repair' }), ctx)).toBe(
			'AGREEMENT_MISSING'
		);
		expect(settlementLineBlocker(byAgreement('2027-06-01', 50_000, { agreementStatus: 'proposed' }), ctx)).toBe('AGREEMENT_NOT_ACCEPTED');
		expect(settlementLineBlocker(byAgreement('2027-06-01', 50_000, { agreementStatus: 'refused' }), ctx)).toBe('AGREEMENT_NOT_ACCEPTED');
		// Accepté le jour même du début du mois, ou après : trop tard.
		expect(settlementLineBlocker(byAgreement('2027-06-01', 50_000, { agreementAcceptedOn: '2027-06-01' }), ctx)).toBe(
			'AGREEMENT_AFTER_PERIOD'
		);
		expect(settlementLineBlocker(byAgreement('2027-06-01', 50_000, { agreementAcceptedOn: '2027-06-10' }), ctx)).toBe(
			'AGREEMENT_AFTER_PERIOD'
		);
		expect(settlementLineBlocker(byAgreement('2027-03-01', 50_000), ctx)).toBe('AGREEMENT_AFTER_PERIOD');
		expect(settlementLineBlocker(byAgreement('2027-07-01', 50_000, { agreementMonths: ['2027-07-01'] }), ctx)).toBe(
			'AGREEMENT_PERIOD_AFTER_EXIT'
		);
		expect(settlementLineBlocker(byAgreement('2027-06-01', 50_000, { agreementMonths: ['2027-05-01'] }), ctx)).toBe(
			'AGREEMENT_MONTH_NOT_COVERED'
		);
		expect(
			rentApplicationBlocker(
				{ id: 'a', type: 'deposit_applied_to_rent', status: 'accepted', acceptedOn: '2027-04-20', months: ['2027-05-01'] },
				{ periodStart: '2027-05-01', amount: 50_000 },
				null
			)
		).toBeNull();
	});

	it('garantie des factures : son propre décompte, factures d’eau et d’électricité justifiées, puis solde', () => {
		const water = claim(6_000, { kind: 'utility_bill', category: 'water_bill' });
		const r = computeSettlement({ ...input([water, repair(5_000)]), accountType: 'utilities_guarantee', received: 20_000 });
		expect(r.lines.map((l) => l.blocker)).toEqual([null, 'LINE_NOT_FOR_ACCOUNT']);
		expect(r.refund).toBe(14_000);
		const ctx = { accountType: 'utilities_guarantee' as const, exitOn: EXIT };
		expect(settlementLineBlocker({ ...water, category: 'plumbing' }, ctx)).toBe('DEBT_NOT_UTILITY_BILL');
		expect(settlementLineBlocker(unpaid(1_000), ctx)).toBe('LINE_NOT_FOR_ACCOUNT');
		expect(settlementLineBlocker(water, { ...ctx, accountType: 'security_deposit' })).toBe('LINE_NOT_FOR_ACCOUNT');
	});

	it('restitution de la partie non contestée, puis du reste ; jamais au-delà', () => {
		const disputed = repair(30_000);
		const first = computeSettlement(input([disputed, repair(5_000)]));
		expect(first.refundRemaining).toBe(65_000);
		// Après l'issue : la ligne contestée tombe à 10 000 ; 65 000 déjà rendus.
		const after = input([{ ...disputed, estimatedAmount: 10_000 }, repair(5_000)], { alreadyRefunded: 65_000 });
		expect(computeSettlement(after).refundRemaining).toBe(20_000);
		expect(settlementMovements(after).find((m) => m.type === 'refunded')?.amount).toBe(20_000);
		expect(() => computeSettlement(input([repair(50_000)], { alreadyRefunded: 60_000 }))).toThrow(/Déjà restitué/);
	});

	it('zéro : la caution couvre exactement les lignes', () => {
		expect(computeSettlement(input([repair(100_000)]))).toMatchObject({ refund: 0, claim: 0, outcome: 'zero' });
	});

	it('montants : entiers FCFA seulement', () => {
		expect(() => computeSettlement(input([], { received: 100.5 }))).toThrow();
		expect(() => computeSettlement(input([], { credit: -1 }))).toThrow();
		expect(computeSettlement(input([repair(10.5)])).lines[0]!.blocker).toBe('AMOUNT_INVALID');
	});
});

describe('scénario B : ce qui restera pour les dégâts', () => {
	it('chaque mois prend ce qu’il peut ; une partie peut être gardée ; alerte quand il ne reste rien', () => {
		const months = [
			{ periodStart: '2027-05-01', outstanding: 50_000 },
			{ periodStart: '2027-06-01', outstanding: 50_000 }
		];
		expect(agreementPlan({ held: 100_000, keep: 0, months })).toMatchObject({ applied: 100_000, remainingForDamage: 0, nothingLeft: true });
		const kept = agreementPlan({ held: 100_000, keep: 30_000, months });
		expect(kept.months.map((m) => [m.applied, m.uncovered])).toEqual([
			[50_000, 0],
			[20_000, 30_000]
		]);
		expect(kept).toMatchObject({ applied: 70_000, remainingForDamage: 30_000, nothingLeft: false });
		expect(agreementPlan({ held: 40_000, keep: 90_000, months }).applied).toBe(0);
	});
});

describe('délai de restitution', () => {
	it('terme = sortie + délai du bail ; alerte une semaine avant, puis en retard ; rien une fois clos', () => {
		const deadline = refundDeadline('2027-06-30', 30);
		expect(deadline).toBe('2027-07-30');
		expect(refundAlert('2027-07-20', deadline, false)).toBe('none');
		expect(refundAlert('2027-07-23', deadline, false)).toBe('soon');
		expect(refundAlert('2027-07-30', deadline, false)).toBe('soon');
		expect(refundAlert('2027-07-31', deadline, false)).toBe('overdue');
		expect(refundAlert('2027-07-31', deadline, true)).toBe('none');
	});
});

describe('statuts du décompte', () => {
	it('brouillon → proposé → accepté ou contesté → clos ; jamais de retour après la clôture', () => {
		expect(canTransitionSettlement('draft', 'proposed')).toBe(true);
		expect(canTransitionSettlement('proposed', 'disputed')).toBe(true);
		expect(canTransitionSettlement('disputed', 'closed')).toBe(true);
		expect(canTransitionSettlement('draft', 'closed')).toBe(false);
		expect(canTransitionSettlement('accepted', 'disputed')).toBe(false);
		for (const s of SETTLEMENT_STATUSES) expect(canTransitionSettlement('closed', s)).toBe(false);
	});
});

// ---------------------------------------------------------------- propriété

/** Générateur pseudo-aléatoire à graine fixe (mulberry32), sans dépendance. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe('propriété : le total des sorties ne dépasse jamais la caution reçue', () => {
	it('2 000 décomptes aléatoires (graine fixe) : sorties = caution reçue, complément = ce qui n’est pas couvert', () => {
		const rand = mulberry32(20261120);
		const int = (max: number) => Math.floor(rand() * (max + 1));
		for (let k = 0; k < 2_000; k++) {
			const received = int(300) * 1_000;
			const lines: SettlementLine[] = [];
			for (let i = int(6); i > 0; i--) {
				const pick = int(5);
				if (pick === 0) lines.push(repair(int(80) * 500, { quoteDocumentId: rand() < 0.85 ? 'devis' : null }));
				else if (pick === 1) lines.push(unpaid(int(100) * 1_000));
				else if (pick === 2) lines.push(claim(int(50) * 1_000, { documentId: rand() < 0.85 ? 'doc' : null }));
				else if (pick === 3) lines.push(byAgreement('2027-06-01', int(60) * 1_000, { executed: rand() < 0.5 }));
				else
					lines.push(
						repair(int(40) * 1_000, { performedBy: 'tenant', selfRepairAgreed: true, status: rand() < 0.5 ? 'verified' : 'done' })
					);
			}
			const inp = input(lines, { received, credit: int(20) * 1_000 });
			const r = computeSettlement(inp);
			const moves = settlementMovements(inp, r);
			const outflows = moves.filter((m) => m.type !== 'additional_claimed').reduce((s, m) => s + m.amount, 0);
			const executed = r.lines
				.filter((l) => l.kind === 'rent_by_agreement' && lines.find((x) => x.id === l.id && x.kind === 'rent_by_agreement' && x.executed))
				.reduce((s, l) => s + l.covered, 0);
			expect(outflows + executed).toBe(received);
			expect(r.coveredByDeposit + r.refundFromDeposit).toBe(received);
			expect(r.coveredByDeposit).toBeLessThanOrEqual(received);
			expect(r.claim + r.creditUsed).toBe(r.deductions - r.coveredByDeposit);
			expect(r.refund > 0 && r.claim > 0).toBe(false);
			for (const l of r.lines) {
				expect(l.covered + l.uncovered).toBe(l.amount);
				if (l.blocker) expect(l.amount).toBe(0);
			}
			for (const m of moves) expect(Number.isSafeInteger(m.amount) && m.amount > 0).toBe(true);
		}
	});
});
