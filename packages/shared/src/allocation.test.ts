/** Imputation des encaissements (lot 09) : cas du prompt, crédit du bail, contre-écriture, test de propriété. */
import { describe, expect, it } from 'vitest';
import {
	allocateDepositPayment,
	allocateRentPayment,
	AllocationError,
	applyLeaseCredit,
	applyLinesToDues,
	creditByPayment,
	forecastRentAllocation,
	leaseCredit,
	netAllocated,
	netByTarget,
	openDuesInOrder,
	reverseAllocations,
	type AllocationLine,
	type DueForAllocation
} from './allocation.js';
import { addDays, addMonths } from './dates.js';

const due = (id: string, dueOn: string, amountDue = 80_000, amountPaid = 0, waived = false): DueForAllocation => ({
	id,
	dueOn,
	periodStart: dueOn.slice(0, 8) + '01',
	amountDue,
	amountPaid,
	waived
});

const dues = [due('nov', '2026-11-05'), due('dec', '2026-12-05'), due('jan', '2027-01-05')];

describe('imputation d’un encaissement de loyer', () => {
	it('paiement exact : l’échéance la plus ancienne est soldée', () => {
		expect(allocateRentPayment('p1', 80_000, dues)).toEqual([
			{ paymentId: 'p1', target: 'rent_due', targetId: 'nov', direction: 'allocate', amount: 80_000 }
		]);
	});

	it('paiement partiel : il reste un solde sur l’échéance', () => {
		const lines = allocateRentPayment('p1', 30_000, dues);
		expect(lines).toEqual([{ paymentId: 'p1', target: 'rent_due', targetId: 'nov', direction: 'allocate', amount: 30_000 }]);
		expect(applyLinesToDues(dues, lines)[0]!.amountPaid).toBe(30_000);
	});

	it('plusieurs échéances en retard : les plus anciennes d’abord, quel que soit l’ordre reçu', () => {
		const lines = allocateRentPayment('p1', 200_000, [...dues].reverse());
		expect(lines.map((l) => [l.targetId, l.amount])).toEqual([
			['nov', 80_000],
			['dec', 80_000],
			['jan', 40_000]
		]);
	});

	it('trop-perçu : sur l’échéance suivante, puis en crédit du bail s’il n’y en a plus', () => {
		const lines = allocateRentPayment('p1', 300_000, dues);
		expect(lines.map((l) => [l.target, l.targetId, l.amount])).toEqual([
			['rent_due', 'nov', 80_000],
			['rent_due', 'dec', 80_000],
			['rent_due', 'jan', 80_000],
			['credit', null, 60_000]
		]);
		expect(leaseCredit(lines)).toBe(60_000);
	});

	it('plusieurs paiements pour une même échéance (plafonds Mobile Money)', () => {
		let state = [due('nov', '2026-11-05', 150_000)];
		const all: AllocationLine[] = [];
		for (const [id, amount] of [
			['p1', 50_000],
			['p2', 50_000],
			['p3', 50_000]
		] as const) {
			const lines = allocateRentPayment(id, amount, state);
			all.push(...lines);
			state = applyLinesToDues(state, lines);
		}
		expect(state[0]!.amountPaid).toBe(150_000);
		expect(all.every((l) => l.targetId === 'nov')).toBe(true);
		expect(leaseCredit(all)).toBe(0);
	});

	it('ignore les échéances abandonnées et soldées ; à égalité de date, le début de période départage', () => {
		const list = [
			due('w', '2026-10-05', 80_000, 0, true),
			due('paid', '2026-10-05', 80_000, 80_000),
			due('b', '2026-11-05'),
			{ ...due('a', '2026-11-05'), periodStart: '2026-10-20' }
		];
		expect(openDuesInOrder(list).map((d) => d.id)).toEqual(['a', 'b']);
	});

	it('montant nul, négatif ou décimal refusé', () => {
		for (const amount of [0, -1, 1.5]) expect(() => allocateRentPayment('p', amount, dues)).toThrow(AllocationError);
	});

	it('versement de caution : une ligne sur le compte', () => {
		expect(allocateDepositPayment('p1', 75_000, 'acc')).toEqual([
			{ paymentId: 'p1', target: 'deposit_account', targetId: 'acc', direction: 'allocate', amount: 75_000 }
		]);
	});
});

describe('crédit du bail', () => {
	it('imputé sur l’échéance émise ensuite, écrit sur l’encaissement d’origine, le plus ancien crédit d’abord', () => {
		const lines = applyLeaseCredit(
			[
				{ paymentId: 'p1', amount: 20_000 },
				{ paymentId: 'p2', amount: 70_000 }
			],
			[due('feb', '2027-02-05', 70_000)]
		);
		expect(lines).toEqual([
			{ paymentId: 'p1', target: 'credit', targetId: null, direction: 'reverse', amount: 20_000 },
			{ paymentId: 'p1', target: 'rent_due', targetId: 'feb', direction: 'allocate', amount: 20_000 },
			{ paymentId: 'p2', target: 'credit', targetId: null, direction: 'reverse', amount: 50_000 },
			{ paymentId: 'p2', target: 'rent_due', targetId: 'feb', direction: 'allocate', amount: 50_000 }
		]);
	});

	it('imputation prévisionnelle de l’appareil : le crédit d’abord, puis le montant saisi', () => {
		const forecast = forecastRentAllocation(
			100_000,
			[due('feb', '2027-02-05', 80_000), due('mar', '2027-03-05', 80_000)],
			[{ paymentId: 'p0', amount: 30_000 }]
		);
		expect(forecast.lines.map((l) => [l.targetId, l.amount])).toEqual([
			['feb', 50_000],
			['mar', 50_000]
		]);
		expect(forecast.credit).toBe(0);
	});
});

describe('contre-écriture d’un encaissement annulé', () => {
	it('une ligne inverse par cible ; l’encaissement n’impute plus rien', () => {
		const lines = allocateRentPayment('p1', 120_000, dues);
		const reversal = reverseAllocations('p1', lines);
		expect(reversal.map((l) => [l.target, l.targetId, l.direction, l.amount])).toEqual([
			['rent_due', 'nov', 'reverse', 80_000],
			['rent_due', 'dec', 'reverse', 40_000]
		]);
		expect(netAllocated([...lines, ...reversal], 'p1')).toBe(0);
		expect(applyLinesToDues(dues, [...lines, ...reversal]).map((d) => d.amountPaid)).toEqual([0, 0, 0]);
	});

	it('crédit déjà imputé sur une échéance suivante : contrepassé avec elle ; le crédit ne devient jamais négatif (point 10)', () => {
		// p1 paie trois mois d'avance sur un bail dont seule l'échéance de janvier existe ; février est émise ensuite.
		let state = [due('jan', '2027-01-05')];
		const p1 = allocateRentPayment('p1', 200_000, state);
		state = applyLinesToDues(state, p1);
		expect(leaseCredit(p1)).toBe(120_000);
		state = [...state, due('feb', '2027-02-05')];
		const fromCredit = applyLeaseCredit([{ paymentId: 'p1', amount: 120_000 }], state);
		state = applyLinesToDues(state, fromCredit);
		const all = [...p1, ...fromCredit];
		expect(state.map((d) => d.amountPaid)).toEqual([80_000, 80_000]);
		expect(leaseCredit(all)).toBe(40_000);

		const reversal = reverseAllocations('p1', all);
		expect(reversal.map((l) => [l.target, l.targetId, l.amount])).toEqual([
			['rent_due', 'jan', 80_000],
			['credit', null, 40_000],
			['rent_due', 'feb', 80_000]
		]);
		const after = [...all, ...reversal];
		expect(applyLinesToDues(state, reversal).map((d) => d.amountPaid)).toEqual([0, 0]);
		expect(leaseCredit(after)).toBe(0);
		expect(() => creditByPayment(after)).not.toThrow();
		expect(netAllocated(after, 'p1')).toBe(0);
	});

	it('n’affecte pas les autres encaissements (pas de réimputation)', () => {
		let state = [...dues];
		const p1 = allocateRentPayment('p1', 80_000, state);
		state = applyLinesToDues(state, p1);
		const p2 = allocateRentPayment('p2', 80_000, state);
		state = applyLinesToDues(state, p2);
		const reversal = reverseAllocations('p1', [...p1, ...p2]);
		state = applyLinesToDues(state, reversal);
		expect(state.map((d) => d.amountPaid)).toEqual([0, 80_000, 0]);
		expect(netAllocated([...p1, ...p2, ...reversal], 'p2')).toBe(80_000);
	});

	it('déjà contrepassé : refusé ; encaissement sans imputation (en attente) : aucune ligne', () => {
		const lines = allocateRentPayment('p1', 80_000, dues);
		expect(() => reverseAllocations('p1', [...lines, ...reverseAllocations('p1', lines)])).toThrow(AllocationError);
		expect(reverseAllocations('p9', lines)).toEqual([]);
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

type Allocator = (paymentId: string, amount: number, dues: readonly DueForAllocation[]) => AllocationLine[];

interface Scenario {
	payments: { id: string; amount: number; cancelled: boolean }[];
	lines: AllocationLine[];
	dues: DueForAllocation[];
}

/** Rejoue un scénario aléatoire et renvoie la première violation d'invariant, ou `null`. */
function runScenario(rand: () => number, allocate: Allocator): string | null {
	const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
	const s: Scenario = { payments: [], lines: [], dues: [] };
	let month = '2026-01-05';
	const issueDue = () => {
		s.dues.push({
			id: `d${s.dues.length}`,
			dueOn: month,
			periodStart: month.slice(0, 8) + '01',
			amountDue: int(1, 250) * 1_000 + int(0, 999),
			amountPaid: 0,
			waived: rand() < 0.05
		});
		month = addMonths(month, 1);
		const credits = [...creditByPayment(s.lines)].map(([paymentId, amount]) => ({ paymentId, amount }));
		const order = new Map(s.payments.map((p, i) => [p.id, i]));
		credits.sort((a, b) => order.get(a.paymentId)! - order.get(b.paymentId)!);
		const lines = applyLeaseCredit(credits, s.dues);
		s.lines.push(...lines);
		s.dues = applyLinesToDues(s.dues, lines);
	};
	for (let i = int(0, 6); i > 0; i -= 1) issueDue();
	const steps = int(5, 40);
	for (let step = 0; step < steps; step += 1) {
		const r = rand();
		if (r < 0.6) {
			const id = `p${s.payments.length}`;
			const amount = rand() < 0.3 ? int(1, 400_000) : int(1, 120) * 5_000;
			const before = s.dues;
			const lines = allocate(id, amount, s.dues);
			s.payments.push({ id, amount, cancelled: false });
			s.lines.push(...lines);
			s.dues = applyLinesToDues(s.dues, lines);
			// Les plus anciennes d'abord : toute échéance ouverte placée avant la dernière servie est soldée.
			const served = lines.filter((l) => l.target === 'rent_due').map((l) => l.targetId);
			const order = openDuesInOrder(before).map((d) => d.id);
			const last = Math.max(-1, ...served.map((dueId) => order.indexOf(dueId!)));
			for (const dueId of order.slice(0, last)) {
				const d = s.dues.find((x) => x.id === dueId)!;
				if (d.amountPaid < d.amountDue) return `échéance ${dueId} sautée`;
			}
			if (lines.some((l) => l.target === 'credit') && openDuesInOrder(s.dues).length)
				return `crédit créé alors que des échéances restent ouvertes`;
		} else if (r < 0.8) {
			issueDue();
		} else {
			const open = s.payments.filter((p) => !p.cancelled);
			if (!open.length) continue;
			const p = open[int(0, open.length - 1)]!;
			const lines = reverseAllocations(p.id, s.lines);
			p.cancelled = true;
			s.lines.push(...lines);
			s.dues = applyLinesToDues(s.dues, lines);
		}
		// Invariants.
		for (const p of s.payments) {
			const net = netAllocated(s.lines, p.id);
			if (net !== (p.cancelled ? 0 : p.amount)) return `somme des imputations de ${p.id} : ${net} au lieu de ${p.cancelled ? 0 : p.amount}`;
		}
		if (s.lines.some((l) => !Number.isSafeInteger(l.amount) || l.amount <= 0)) return 'ligne de montant non positif';
		for (const d of s.dues) {
			const net = netByTarget(s.lines).get(`rent_due:${d.id}`)?.amount ?? 0;
			if (net !== d.amountPaid) return `échéance ${d.id} : ${d.amountPaid} payé, ${net} imputé`;
			if (d.amountPaid < 0 || d.amountPaid > d.amountDue) return `échéance ${d.id} hors bornes`;
			if (d.waived && d.amountPaid > 0) return `échéance abandonnée ${d.id} imputée`;
		}
		try {
			creditByPayment(s.lines);
		} catch {
			return 'crédit négatif';
		}
		const totalActive = s.payments.filter((p) => !p.cancelled).reduce((sum, p) => sum + p.amount, 0);
		const totalDues = s.dues.reduce((sum, d) => sum + d.amountPaid, 0);
		if (totalDues + leaseCredit(s.lines) !== totalActive) return 'échéances et crédit ne font pas le total des encaissements';
	}
	return null;
}

describe('propriété : somme des imputations = montant du paiement', () => {
	const SEED = 0x09_2026;
	const RUNS = 1_500;

	it(`${RUNS} scénarios aléatoires (paiements, échéances émises, annulations), à graine fixe`, () => {
		const rand = mulberry32(SEED);
		for (let run = 0; run < RUNS; run += 1) {
			const violation = runScenario(rand, allocateRentPayment);
			expect(violation, `scénario ${run}`).toBeNull();
		}
	});

	it('le test détecte une erreur injectée : imputer la plus récente d’abord', () => {
		const newestFirst: Allocator = (id, amount, list) =>
			allocateRentPayment(
				id,
				amount,
				openDuesInOrder(list)
					.reverse()
					.map((d, i) => ({ ...d, dueOn: addDays('2000-01-01', i) }))
			);
		const rand = mulberry32(SEED);
		let caught = false;
		for (let run = 0; run < 200 && !caught; run += 1) caught = runScenario(rand, newestFirst) !== null;
		expect(caught).toBe(true);
	});

	it('le test détecte une erreur injectée : un franc perdu sur le crédit', () => {
		const leaky: Allocator = (id, amount, list) =>
			allocateRentPayment(id, amount, list).map((l) => (l.target === 'credit' && l.amount > 1 ? { ...l, amount: l.amount - 1 } : l));
		const rand = mulberry32(SEED + 1);
		let caught = false;
		for (let run = 0; run < 200 && !caught; run += 1) caught = runScenario(rand, leaky) !== null;
		expect(caught).toBe(true);
	});
});
