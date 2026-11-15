import { describe, expect, it } from 'vitest';
import { addDays, addMonths } from './dates.js';
import {
	anniversaryStart,
	endOnFromDuration,
	generateRentSchedule,
	isAnniversaryOf,
	MONTHS_PER_PERIOD,
	prorate,
	RENT_BILLING_MODES,
	rentChangeBlocker,
	rentDueUpdates,
	RentScheduleError,
	scheduleUntil,
	type IssuedRentDue,
	type RentBillingMode,
	type RentDueDraft,
	type RentPeriodicity,
	type RentRate,
	type RentScheduleInput
} from './rent-schedule.js';

const rate = (effectiveFrom: string, rent = 75_000, charges = 5_000, version = 1): RentRate => ({ effectiveFrom, rent, charges, version });

function lease(over: Partial<RentScheduleInput> & Pick<RentScheduleInput, 'startOn'>): RentScheduleInput {
	const endOn = over.endOn === undefined ? null : over.endOn;
	const duesStartOn = over.duesStartOn ?? over.startOn;
	return {
		billingMode: 'calendar_prorata',
		periodicity: 'monthly',
		endOn,
		duesStartOn,
		dueDay: 5,
		advanceMonths: 0,
		activatedOn: over.startOn,
		rates: [rate(over.startOn)],
		until: endOn ?? scheduleUntil({ endOn, duesStartOn }, over.startOn),
		...over
	};
}

const starts = (dues: RentDueDraft[]) => dues.map((d) => d.periodStart);

describe('dates : mois', () => {
	it('ajoute des mois au même jour, ou au dernier jour d’un mois plus court', () => {
		expect(addMonths('2027-01-31', 1)).toBe('2027-02-28');
		expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
		expect(addMonths('2027-01-31', 2)).toBe('2027-03-31');
		expect(addMonths('2026-11-17', 14)).toBe('2028-01-17');
		expect(addMonths('2027-03-31', -1)).toBe('2027-02-28');
	});
	it('fin d’un bail de N mois : la veille du même jour', () => {
		expect(endOnFromDuration('2026-11-17', 12)).toBe('2027-11-16');
		expect(endOnFromDuration('2026-01-01', 12)).toBe('2026-12-31');
		expect(() => endOnFromDuration('2026-01-01', 0)).toThrow(RentScheduleError);
	});
});

describe('prorata en entiers', () => {
	it('arrondit à l’inférieur, sans flottant, même pour un grand montant', () => {
		expect(prorate(75_000, 14, 30)).toBe(35_000);
		expect(prorate(5_000, 14, 30)).toBe(2_333);
		expect(prorate(100_000, 1, 31)).toBe(3_225);
		expect(prorate(Number.MAX_SAFE_INTEGER, 30, 31)).toBe(Number((BigInt(Number.MAX_SAFE_INTEGER) * 30n) / 31n));
		expect(Number.isInteger(prorate(99_999, 17, 31))).toBe(true);
	});
	it('refuse un montant non entier ou des jours incohérents', () => {
		expect(() => prorate(75_000.5, 1, 30)).toThrow();
		expect(() => prorate(75_000, 31, 30)).toThrow(RentScheduleError);
	});
});

describe('bail de 12 mois', () => {
	it('du 1er janvier au 31 décembre : 12 échéances entières, le 5 de chaque mois', () => {
		const dues = generateRentSchedule(lease({ startOn: '2026-01-01', endOn: '2026-12-31' }));
		expect(dues).toHaveLength(12);
		expect(dues.every((d) => d.amountDue === 80_000 && !d.prorated && !d.isAdvance)).toBe(true);
		expect(dues.map((d) => d.dueOn)).toEqual(Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}-05`));
		expect(dues.at(-1)).toMatchObject({ periodStart: '2026-12-01', periodEnd: '2026-12-31' });
	});

	it('calendar_prorata, entrée le 17 : premier et dernier mois au prorata, le premier dû à la signature', () => {
		const dues = generateRentSchedule(
			lease({ startOn: '2026-11-17', endOn: endOnFromDuration('2026-11-17', 12), activatedOn: '2026-11-10' })
		);
		expect(dues).toHaveLength(13);
		expect(dues[0]).toMatchObject({
			periodStart: '2026-11-17',
			periodEnd: '2026-11-30',
			rent: 35_000,
			charges: 2_333,
			amountDue: 37_333,
			prorated: true,
			dueAtSignature: true,
			isAdvance: false,
			dueOn: '2026-11-10'
		});
		expect(dues[1]).toMatchObject({ periodStart: '2026-12-01', amountDue: 80_000, dueOn: '2026-12-05', prorated: false });
		expect(dues[12]).toMatchObject({
			periodStart: '2027-11-01',
			periodEnd: '2027-11-16',
			rent: 40_000,
			charges: 2_666,
			dueOn: '2027-11-05'
		});
	});

	it('calendar_full_first, entrée le 17 : premier mois entier, dû le jour d’entrée ; dernier au prorata', () => {
		const dues = generateRentSchedule(
			lease({ billingMode: 'calendar_full_first', startOn: '2026-11-17', endOn: endOnFromDuration('2026-11-17', 12) })
		);
		expect(dues).toHaveLength(13);
		expect(dues[0]).toMatchObject({ periodStart: '2026-11-17', amountDue: 80_000, prorated: false, dueOn: '2026-11-17' });
		expect(dues[12]).toMatchObject({ periodEnd: '2027-11-16', rent: 40_000, prorated: true });
	});

	it('anniversary, entrée le 17 : 12 périodes du 17 au 16, dues le 17, sans prorata', () => {
		const dues = generateRentSchedule(
			lease({ billingMode: 'anniversary', startOn: '2026-11-17', endOn: endOnFromDuration('2026-11-17', 12) })
		);
		expect(dues).toHaveLength(12);
		expect(dues[0]).toMatchObject({ periodStart: '2026-11-17', periodEnd: '2026-12-16', dueOn: '2026-11-17' });
		expect(dues[11]).toMatchObject({ periodStart: '2027-10-17', periodEnd: '2027-11-16' });
		expect(dues.every((d) => d.amountDue === 80_000 && !d.prorated)).toBe(true);
	});
});

describe('bail sans fin', () => {
	it('12 mois glissants, puis prolongation sans doublon ni changement des échéances déjà générées', () => {
		const base = lease({ startOn: '2026-11-01' });
		const first = generateRentSchedule({ ...base, until: scheduleUntil(base, '2026-11-01') });
		expect(first).toHaveLength(12);
		expect(first.at(-1)?.periodStart).toBe('2027-10-01');
		const later = generateRentSchedule({ ...base, until: scheduleUntil(base, '2027-02-15') });
		expect(later.at(-1)?.periodStart).toBe('2028-02-01');
		expect(later.slice(0, first.length)).toEqual(first);
		expect(new Set(starts(later)).size).toBe(later.length);
	});
	it('l’horizon part de la date du jour, ou du début de facturation s’il est plus tard', () => {
		expect(scheduleUntil({ endOn: null, duesStartOn: '2026-11-17' }, '2026-11-01')).toBe('2027-11-16');
		expect(scheduleUntil({ endOn: null, duesStartOn: '2026-01-01' }, '2026-11-15')).toBe('2027-11-14');
		expect(scheduleUntil({ endOn: '2027-06-30', duesStartOn: '2026-01-01' }, '2026-11-15')).toBe('2027-06-30');
	});
});

describe('entrée le 29, le 30 ou le 31', () => {
	it('anniversary, le 31 : 28 février (29 en année bissextile), puis 31 mars, sans glissement', () => {
		const dues = generateRentSchedule(
			lease({ billingMode: 'anniversary', startOn: '2027-01-31', endOn: endOnFromDuration('2027-01-31', 14) })
		);
		expect(starts(dues).slice(0, 5)).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31']);
		expect(dues[0]?.periodEnd).toBe('2027-02-27');
		expect(dues[1]?.periodEnd).toBe('2027-03-30');
		expect(starts(dues)[13]).toBe('2028-02-29');
		expect(dues.map((d) => d.dueOn)).toEqual(starts(dues));
	});
	it('anniversary, le 29 et le 30 : février ramené au dernier jour, les autres mois au jour d’entrée', () => {
		expect([0, 1, 2].map((k) => anniversaryStart('2027-01-29', k))).toEqual(['2027-01-29', '2027-02-28', '2027-03-29']);
		expect([0, 1, 2].map((k) => anniversaryStart('2027-01-30', k))).toEqual(['2027-01-30', '2027-02-28', '2027-03-30']);
		expect([0, 1, 2].map((k) => anniversaryStart('2028-01-30', k))).toEqual(['2028-01-30', '2028-02-29', '2028-03-30']);
		expect(isAnniversaryOf('2027-02-28', '2027-01-30')).toBe(true);
		expect(isAnniversaryOf('2027-02-27', '2027-01-30')).toBe(false);
	});
	it('calendar_prorata, le 31 : un jour sur 31, dû à la signature', () => {
		const dues = generateRentSchedule(
			lease({ startOn: '2027-01-31', endOn: '2027-12-31', activatedOn: '2027-01-20', rates: [rate('2027-01-31', 93_000, 0)] })
		);
		expect(dues[0]).toMatchObject({ periodStart: '2027-01-31', periodEnd: '2027-01-31', rent: 3_000, dueOn: '2027-01-20' });
		expect(dues[1]).toMatchObject({ periodStart: '2027-02-01', periodEnd: '2027-02-28', rent: 93_000, dueOn: '2027-02-05' });
	});
});

describe('jour d’échéance 28', () => {
	it('le 28 de chaque mois, février compris', () => {
		const dues = generateRentSchedule(lease({ startOn: '2027-01-01', endOn: '2027-12-31', dueDay: 28 }));
		expect(dues.map((d) => d.dueOn.slice(8))).toEqual(Array(12).fill('28'));
		expect(dues[1]?.dueOn).toBe('2027-02-28');
	});
	it('refuse un jour hors de 1 à 28', () => {
		expect(() => generateRentSchedule(lease({ startOn: '2027-01-01', endOn: '2027-12-31', dueDay: 29 }))).toThrow(RentScheduleError);
		expect(() => generateRentSchedule(lease({ startOn: '2027-01-01', endOn: '2027-12-31', dueDay: 0 }))).toThrow(RentScheduleError);
	});
	it('un dernier mois qui finit avant le jour d’échéance est dû le jour de sa fin', () => {
		const dues = generateRentSchedule(lease({ startOn: '2027-01-01', endOn: '2027-03-03', dueDay: 28 }));
		expect(dues.at(-1)).toMatchObject({ periodStart: '2027-03-01', periodEnd: '2027-03-03', dueOn: '2027-03-03', prorated: true });
	});
});

describe('avance', () => {
	it('calendar_prorata : le premier mois incomplet est dû en plus ; les N mois entiers suivants sont l’avance', () => {
		const dues = generateRentSchedule(
			lease({ startOn: '2026-11-17', endOn: endOnFromDuration('2026-11-17', 12), advanceMonths: 2, activatedOn: '2026-11-10' })
		);
		expect(dues.slice(0, 4).map((d) => [d.periodStart, d.isAdvance, d.dueAtSignature, d.dueOn])).toEqual([
			['2026-11-17', false, true, '2026-11-10'],
			['2026-12-01', true, true, '2026-11-10'],
			['2027-01-01', true, true, '2026-11-10'],
			['2027-02-01', false, false, '2027-02-05']
		]);
	});
	it('calendar_full_first et anniversary : le premier mois entier compte dans l’avance', () => {
		for (const billingMode of ['calendar_full_first', 'anniversary'] as const) {
			const dues = generateRentSchedule(
				lease({
					billingMode,
					startOn: '2026-11-17',
					endOn: endOnFromDuration('2026-11-17', 12),
					advanceMonths: 2,
					activatedOn: '2026-11-10'
				})
			);
			expect(dues.map((d) => d.isAdvance).slice(0, 3)).toEqual([true, true, false]);
			expect(dues.slice(0, 2).every((d) => d.dueOn === '2026-11-10')).toBe(true);
		}
	});
	it('une échéance d’avance déjà passée à la signature reste à sa date normale', () => {
		const dues = generateRentSchedule(lease({ startOn: '2026-09-01', endOn: '2027-08-31', advanceMonths: 1, activatedOn: '2026-11-15' }));
		expect(dues[0]).toMatchObject({ isAdvance: true, dueOn: '2026-09-05' });
	});
	it('une avance plus longue que le bail s’arrête à sa dernière échéance', () => {
		const dues = generateRentSchedule(lease({ startOn: '2027-01-01', endOn: '2027-02-28', advanceMonths: 6 }));
		expect(dues.map((d) => d.isAdvance)).toEqual([true, true]);
	});
});

describe('bail repris en cours (dues_start_on)', () => {
	it('ne génère rien avant la première date facturée', () => {
		const dues = generateRentSchedule(
			lease({ startOn: '2023-03-01', duesStartOn: '2026-11-01', rates: [rate('2023-03-01')], until: '2027-10-31' })
		);
		expect(dues[0]?.periodStart).toBe('2026-11-01');
		expect(dues).toHaveLength(12);
	});
	it('anniversary : la facturation commence un jour anniversaire de l’entrée', () => {
		const ok = generateRentSchedule(
			lease({
				billingMode: 'anniversary',
				startOn: '2025-01-31',
				duesStartOn: '2026-02-28',
				rates: [rate('2025-01-31')],
				until: '2026-06-30'
			})
		);
		expect(starts(ok)).toEqual(['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
		expect(() =>
			generateRentSchedule(
				lease({ billingMode: 'anniversary', startOn: '2025-01-31', duesStartOn: '2026-02-27', rates: [rate('2025-01-31')] })
			)
		).toThrow(RentScheduleError);
	});
	it('refuse une facturation hors du bail', () => {
		expect(() => generateRentSchedule(lease({ startOn: '2026-01-01', duesStartOn: '2025-12-01' }))).toThrow(RentScheduleError);
		expect(() => generateRentSchedule(lease({ startOn: '2026-01-01', endOn: '2026-06-30', duesStartOn: '2026-07-01' }))).toThrow(
			RentScheduleError
		);
	});
});

describe('changement de loyer en cours de bail', () => {
	const base = lease({ startOn: '2026-01-01', endOn: '2026-12-31' });
	const changed: RentScheduleInput = { ...base, rates: [rate('2026-01-01'), rate('2026-07-01', 90_000, 6_000, 2)] };

	it('le nouveau tarif s’applique aux périodes qui commencent à sa date d’effet', () => {
		const before = generateRentSchedule(base);
		const after = generateRentSchedule(changed);
		expect(after.slice(0, 6)).toEqual(before.slice(0, 6));
		expect(after.slice(6).every((d) => d.amountDue === 96_000 && d.leaseVersion === 2)).toBe(true);
	});

	it('les échéances déjà émises ne changent jamais ; les suivantes, à venir et sans paiement, sont recalculées', () => {
		const existing: IssuedRentDue[] = generateRentSchedule(base).map((d, i) => ({
			periodStart: d.periodStart,
			rent: d.rent,
			charges: d.charges,
			amountDue: d.amountDue,
			leaseVersion: d.leaseVersion,
			status: i < 7 ? 'due' : 'upcoming',
			amountPaid: i === 8 ? 10_000 : 0
		}));
		const updates = rentDueUpdates(existing, generateRentSchedule(changed));
		expect(updates.map((u) => u.periodStart)).toEqual(['2026-08-01', '2026-10-01', '2026-11-01', '2026-12-01']);
		expect(updates.every((u) => u.amountDue === 96_000 && u.leaseVersion === 2)).toBe(true);
	});

	it('refuse une date d’effet sur une échéance émise, hors d’un début de période ou hors du bail', () => {
		const existing: IssuedRentDue[] = generateRentSchedule(base).map((d, i) => ({
			...d,
			status: i < 7 ? 'due' : 'upcoming',
			amountPaid: 0
		}));
		expect(rentChangeBlocker(base, '2026-07-01', existing)).toBe('RENT_CHANGE_ON_ISSUED_DUE');
		expect(rentChangeBlocker(base, '2026-08-01', existing)).toBeNull();
		expect(rentChangeBlocker(base, '2026-08-15', existing)).toBe('RENT_CHANGE_NOT_PERIOD_START');
		expect(rentChangeBlocker(base, '2027-01-01', existing)).toBe('RENT_CHANGE_OUT_OF_LEASE');
		const open = lease({ startOn: '2026-01-01' });
		expect(rentChangeBlocker(open, '2029-03-01', [])).toBeNull();
	});
});

describe('trimestriel (prévu, hors MVP)', () => {
	it('trimestres civils, premier trimestre incomplet au prorata', () => {
		const dues = generateRentSchedule(
			lease({ periodicity: 'quarterly', startOn: '2026-02-01', endOn: '2026-12-31', rates: [rate('2026-02-01', 225_000, 0)] })
		);
		expect(dues.map((d) => [d.periodStart, d.periodEnd])).toEqual([
			['2026-02-01', '2026-03-31'],
			['2026-04-01', '2026-06-30'],
			['2026-07-01', '2026-09-30'],
			['2026-10-01', '2026-12-31']
		]);
		expect(dues[0]?.rent).toBe(prorate(225_000, 59, 90));
	});
	it('l’avance compte en trimestres entiers', () => {
		expect(() => generateRentSchedule(lease({ periodicity: 'quarterly', startOn: '2026-01-01', advanceMonths: 2 }))).toThrow(
			RentScheduleError
		);
	});
});

describe('montants : uniquement des entiers FCFA', () => {
	it('refuse un loyer décimal ou négatif', () => {
		expect(() => generateRentSchedule(lease({ startOn: '2026-01-01', rates: [rate('2026-01-01', 75_000.5)] }))).toThrow();
		expect(() => generateRentSchedule(lease({ startOn: '2026-01-01', rates: [rate('2026-01-01', -1)] }))).toThrow();
	});
	it('refuse des dates d’effet non croissantes ou un loyer qui commence après la facturation', () => {
		expect(() => generateRentSchedule(lease({ startOn: '2026-01-01', rates: [rate('2026-01-01'), rate('2026-01-01')] }))).toThrow(
			RentScheduleError
		);
		expect(() => generateRentSchedule(lease({ startOn: '2026-01-01', rates: [rate('2026-02-01')] }))).toThrow(RentScheduleError);
	});
});

// ---------------------------------------------------------------- test de propriété (critère d'acceptation)

/** Générateur pseudo-aléatoire à graine fixe (mulberry32), sans dépendance. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

// Oracle : parcourt le bail jour par jour, avec sa propre arithmétique des dates (objets Date), sans les fonctions
// de rent-schedule.ts ni de dates.ts.
const DAY = 86_400_000;
const toTime = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const fromTime = (t: number) => new Date(t).toISOString().slice(0, 10);
const lastDayOf = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

/** Débuts des périodes anniversaire, construits mois par mois. */
function oracleAnniversaryStarts(startOn: string, perPeriod: number, through: number): Set<number> {
	const s = new Date(toTime(startOn));
	const day = s.getUTCDate();
	const out = new Set<number>();
	for (let n = 0; ; n += perPeriod) {
		const y = s.getUTCFullYear() + Math.floor((s.getUTCMonth() + n) / 12);
		const m0 = (s.getUTCMonth() + n) % 12;
		const t = Date.UTC(y, m0, Math.min(day, lastDayOf(y, m0)));
		out.add(t);
		if (t > through) return out;
	}
}

interface OraclePeriod {
	start: number;
	end: number;
	nominalDays: number;
	nominalFirstMonth: [number, number];
}

function oracleSchedule(input: RentScheduleInput): RentDueDraft[] {
	const perPeriod = input.periodicity === 'quarterly' ? 3 : 1;
	const end = input.endOn ? toTime(input.endOn) : Infinity;
	const until = toTime(input.until);
	const anniversary = input.billingMode === 'anniversary';
	const annStarts = anniversary ? oracleAnniversaryStarts(input.startOn, perPeriod, Math.min(end, until) + 400 * DAY) : new Set<number>();
	const calendarKey = (t: number) => {
		const d = new Date(t);
		return `${d.getUTCFullYear()}-${Math.floor(d.getUTCMonth() / perPeriod)}`;
	};
	const periods: OraclePeriod[] = [];
	let current: OraclePeriod | null = null;
	for (let t = toTime(input.duesStartOn); t <= end; t += DAY) {
		const startsNew = !current || (anniversary ? annStarts.has(t) : calendarKey(t) !== calendarKey(t - DAY));
		if (startsNew) {
			if (t > until) break;
			let nominalDays = 0;
			let nominalFirst: [number, number];
			if (anniversary) {
				let u = t;
				do {
					nominalDays += 1;
					u += DAY;
				} while (!annStarts.has(u));
				const d = new Date(t);
				nominalFirst = [d.getUTCFullYear(), d.getUTCMonth()];
			} else {
				let u = t;
				while (calendarKey(u - DAY) === calendarKey(t)) u -= DAY;
				const d = new Date(u);
				nominalFirst = [d.getUTCFullYear(), d.getUTCMonth()];
				for (; calendarKey(u) === calendarKey(t); u += DAY) nominalDays += 1;
			}
			current = { start: t, end: t, nominalDays, nominalFirstMonth: nominalFirst };
			periods.push(current);
		} else {
			current!.end = t;
		}
	}
	let advanceLeft = input.advanceMonths / perPeriod;
	return periods.map((p, index) => {
		const days = (p.end - p.start) / DAY + 1;
		const [y, m0] = p.nominalFirstMonth;
		const startsAtNominal = anniversary || (new Date(p.start).getUTCDate() === 1 && new Date(p.start).getUTCMonth() === m0);
		const partial = days !== p.nominalDays;
		let prorated = false;
		if (input.billingMode === 'calendar_prorata') prorated = partial;
		if (input.billingMode === 'calendar_full_first') prorated = index > 0 && partial;
		const entry = input.billingMode === 'calendar_prorata' && index === 0 && !startsAtNominal;
		const isAdvance = !entry && advanceLeft > 0;
		if (isAdvance) advanceLeft -= 1;
		const startIso = fromTime(p.start);
		let r = input.rates[0]!;
		for (const x of input.rates) if (x.effectiveFrom <= startIso) r = x;
		const rent = prorated ? Math.floor((r.rent * days) / p.nominalDays) : r.rent;
		const charges = prorated ? Math.floor((r.charges * days) / p.nominalDays) : r.charges;
		let regular: number;
		if (anniversary) regular = p.start;
		else regular = Math.min(Math.max(Date.UTC(y, m0, input.dueDay), p.start), p.end);
		const dueAtSignature = entry || isAdvance;
		const due = dueAtSignature ? Math.min(toTime(input.activatedOn), regular) : regular;
		return {
			periodStart: startIso,
			periodEnd: fromTime(p.end),
			dueOn: fromTime(due),
			rent,
			charges,
			amountDue: rent + charges,
			prorated,
			isAdvance,
			dueAtSignature,
			leaseVersion: r.version
		};
	});
}

function randomLease(rand: () => number, billingMode: RentBillingMode): RentScheduleInput {
	const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
	const periodicity: RentPeriodicity = rand() < 0.85 ? 'monthly' : 'quarterly';
	const perPeriod = MONTHS_PER_PERIOD[periodicity];
	const year = int(2025, 2028);
	const month = int(1, 12);
	// Une fois sur trois, une entrée en fin de mois (29, 30, 31) ou le 1er.
	const pick = rand();
	const lastDay = lastDayOf(year, month - 1);
	const day = pick < 0.33 ? Math.max(1, lastDay - int(0, 2)) : pick < 0.45 ? 1 : int(1, lastDay);
	const startOn = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
	const fixed = rand() < 0.6;
	let endOn: string | null = null;
	if (fixed) endOn = rand() < 0.5 ? endOnFromDuration(startOn, int(1, 24)) : addDays(startOn, int(0, 730));
	// Bail repris en cours une fois sur cinq.
	let duesStartOn = startOn;
	if (rand() < 0.2) {
		if (billingMode === 'anniversary') duesStartOn = anniversaryStart(startOn, int(0, 6), perPeriod);
		else duesStartOn = addDays(startOn, int(0, 200));
		if (endOn && duesStartOn > endOn) duesStartOn = startOn;
	}
	const until = endOn ?? addDays(addMonths(duesStartOn, 24), -1);
	const rates: RentRate[] = [
		{ effectiveFrom: startOn, rent: int(5_000, 2_000_000), charges: rand() < 0.4 ? 0 : int(0, 100_000), version: 1 }
	];
	for (let v = 2; v <= int(1, 3); v++) {
		const from = addDays(rates.at(-1)!.effectiveFrom, int(1, 400));
		rates.push({ effectiveFrom: from, rent: int(5_000, 2_000_000), charges: int(0, 100_000), version: v });
	}
	return {
		billingMode,
		periodicity,
		startOn,
		endOn,
		duesStartOn,
		dueDay: int(1, 28),
		advanceMonths: perPeriod * int(0, 4),
		activatedOn: addDays(startOn, int(-60, 60)),
		rates,
		until
	};
}

describe('test de propriété : échéancier juste sur 24 mois, trois modes', () => {
	const SEED = 20_261_115;
	const CASES = 700;

	for (const mode of RENT_BILLING_MODES) {
		it(`${mode} : identique à l’oracle jour par jour, et invariants tenus (graine ${SEED})`, () => {
			const rand = mulberry32(SEED + RENT_BILLING_MODES.indexOf(mode));
			for (let i = 0; i < CASES; i++) {
				const input = randomLease(rand, mode);
				const context = `cas ${i} : ${JSON.stringify(input)}`;
				const dues = generateRentSchedule(input);
				expect(dues, context).toEqual(oracleSchedule(input));

				// Contiguës, sans trou ni chevauchement, du début de la facturation à la fin du bail (ou de l'horizon).
				expect(dues.length, context).toBeGreaterThan(0);
				expect(dues[0]!.periodStart, context).toBe(input.duesStartOn);
				for (let k = 1; k < dues.length; k++) expect(dues[k]!.periodStart, context).toBe(addDays(dues[k - 1]!.periodEnd, 1));
				const last = dues.at(-1)!;
				if (input.endOn && input.endOn <= input.until) expect(last.periodEnd, context).toBe(input.endOn);
				else expect(last.periodStart <= input.until && addDays(last.periodEnd, 1) > input.until, context).toBe(true);
				if (!input.endOn) {
					// 24 mois couverts.
					expect(last.periodEnd >= addDays(addMonths(input.duesStartOn, 24), -1), context).toBe(true);
				}

				let advance = 0;
				for (const d of dues) {
					const r = [...input.rates].reverse().find((x) => x.effectiveFrom <= d.periodStart)!;
					expect(Number.isSafeInteger(d.rent) && d.rent >= 0 && Number.isSafeInteger(d.charges) && d.charges >= 0, context).toBe(true);
					expect(d.amountDue, context).toBe(d.rent + d.charges);
					if (d.prorated) expect(d.rent <= r.rent && d.charges <= r.charges, context).toBe(true);
					else expect([d.rent, d.charges, d.leaseVersion], context).toEqual([r.rent, r.charges, r.version]);
					if (mode === 'anniversary') expect(d.prorated, context).toBe(false);
					expect(d.dueOn <= d.periodEnd, context).toBe(true);
					if (!d.dueAtSignature) expect(d.dueOn >= d.periodStart, context).toBe(true);
					if (d.isAdvance) advance += 1;
				}
				const perPeriod = MONTHS_PER_PERIOD[input.periodicity];
				const entry = dues[0]!.dueAtSignature && !dues[0]!.isAdvance;
				expect(advance, context).toBe(Math.min(input.advanceMonths / perPeriod, dues.length - (entry ? 1 : 0)));
				// Les avances sont les premières échéances (hors premier mois incomplet).
				const flags = dues.map((d) => d.isAdvance);
				expect(
					flags.slice(flags.indexOf(false) === -1 ? flags.length : flags.lastIndexOf(true) + 1).every((f) => !f),
					context
				).toBe(true);

				// Rejeu : mêmes échéances. Un changement de loyer ne touche que les périodes à partir de sa date d'effet.
				expect(generateRentSchedule(input), context).toEqual(dues);
				if (input.rates.length > 1) {
					const firstOnly = generateRentSchedule({ ...input, rates: [input.rates[0]!] });
					const pivot = input.rates[1]!.effectiveFrom;
					expect(
						dues.filter((d) => d.periodStart < pivot),
						context
					).toEqual(firstOnly.filter((d) => d.periodStart < pivot));
				}
				// Prolonger l'horizon d'un bail sans fin ne change aucune échéance déjà générée.
				if (!input.endOn) {
					const longer = generateRentSchedule({ ...input, until: addMonths(input.until, 3) });
					expect(longer.slice(0, dues.length), context).toEqual(dues);
				}
			}
		});
	}
});
