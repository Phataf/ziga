/**
 * Échéancier des loyers (lot 08), fonction pure : la même sert au serveur, qui écrit les lignes `rent_dues` à la
 * validation du bail et dans la tâche quotidienne, et à l'appareil, qui en montre l'aperçu hors connexion.
 *
 * Trois modes de découpage (`rent_billing_mode`, réglage de l'organisation recopié dans le bail à sa création, figé
 * ensuite) :
 * - `calendar_prorata` (par défaut) : mois civils ; premier et dernier mois incomplets au prorata des jours,
 *   arrondis à l'inférieur, en entiers. Le premier mois incomplet est dû à la signature et ne compte pas dans
 *   l'avance : les N mois d'avance sont les N mois entiers qui le suivent.
 * - `calendar_full_first` : mois civils ; premier mois facturé en entier (il compte dans l'avance) ; dernier mois
 *   incomplet au prorata.
 * - `anniversary` : périodes depuis le jour d'entrée (du 17 au 16), toujours recalculées depuis ce jour (une entrée
 *   le 31 donne le 28 ou 29 février, puis le 31 mars, sans glissement) ; jamais de prorata, une dernière période
 *   écourtée est due en entier. L'échéance est le premier jour de la période ; `dueDay` n'y sert pas.
 *
 * Dates d'échéance : le `dueDay` (1 à 28) du mois de la période en mode civil, ramené dans la période (un mois qui
 * commence après ce jour est dû le jour de son début ; un dernier mois qui finit avant, le jour de sa fin). Les
 * échéances d'avance, et le premier mois incomplet en mode `calendar_prorata`, sont dues à la signature (date de
 * validation du bail), ou à leur date normale si elle est déjà passée.
 *
 * Changement de loyer : chaque tarif s'applique aux périodes qui commencent à sa date d'effet ou après. Les échéances
 * déjà émises ne changent jamais (`rentDueUpdates`).
 *
 * Montants (règle 2) : entiers FCFA, prorata calculé en entiers exacts (BigInt), jamais de flottant.
 */
import { addDays, addMonths, daysBetween, isIsoDate, monthDay } from './dates.js';
import { assertFcfa, type Fcfa } from './money.js';

export const RENT_BILLING_MODES = ['calendar_prorata', 'calendar_full_first', 'anniversary'] as const;
export type RentBillingMode = (typeof RENT_BILLING_MODES)[number];
export const DEFAULT_RENT_BILLING_MODE: RentBillingMode = 'calendar_prorata';

/** Périodicité : mensuelle au MVP ; trimestrielle prévue (trimestres civils, ou tous les trois mois en anniversaire). */
export const RENT_PERIODICITIES = ['monthly', 'quarterly'] as const;
export type RentPeriodicity = (typeof RENT_PERIODICITIES)[number];
export const MONTHS_PER_PERIOD: Record<RentPeriodicity, number> = { monthly: 1, quarterly: 3 };

/** Bail sans fin : échéances générées sur 12 mois glissants, prolongées chaque jour. */
export const ROLLING_HORIZON_MONTHS = 12;

/** Tarif d'une version du bail, à partir de sa date d'effet (aaaa-mm-jj). */
export interface RentRate {
	effectiveFrom: string;
	rent: Fcfa;
	charges: Fcfa;
	version: number;
}

export interface RentScheduleInput {
	billingMode: RentBillingMode;
	periodicity: RentPeriodicity;
	/** Date d'entrée du bail ; ancre des périodes en mode anniversaire. */
	startOn: string;
	/** Fin du bail, incluse ; `null` pour un bail sans fin. */
	endOn: string | null;
	/** Première date facturée (par défaut, l'entrée ; plus tard pour un bail repris en cours). */
	duesStartOn: string;
	/** Jour d'échéance, de 1 à 28 (mode civil). */
	dueDay: number;
	/** Mois payés d'avance, entiers ; multiple de la périodicité. */
	advanceMonths: number;
	/** Date de signature (validation du bail) : échéance des sommes dues à l'entrée. */
	activatedOn: string;
	/** Tarifs successifs, dates d'effet croissantes ; le premier couvre la première période. */
	rates: readonly RentRate[];
	/** Dernière date de début de période générée (fin du bail, ou horizon glissant). */
	until: string;
}

export interface RentDueDraft {
	periodStart: string;
	periodEnd: string;
	dueOn: string;
	rent: Fcfa;
	charges: Fcfa;
	amountDue: Fcfa;
	/** Montant réduit au prorata des jours. */
	prorated: boolean;
	/** Une des N échéances payées d'avance. */
	isAdvance: boolean;
	/** Due à la signature : avance, ou premier mois incomplet en `calendar_prorata`. */
	dueAtSignature: boolean;
	/** Version du bail dont le tarif a servi. */
	leaseVersion: number;
}

export class RentScheduleError extends RangeError {
	constructor(message: string) {
		super(message);
		this.name = 'RentScheduleError';
	}
}

const minDate = (a: string, b: string): string => (a < b ? a : b);
const maxDate = (a: string, b: string): string => (a > b ? a : b);

function ymd(iso: string): [number, number, number] {
	return iso.split('-').map(Number) as [number, number, number];
}

/** Montant au prorata de `days` jours sur `periodDays`, arrondi à l'inférieur, sans flottant. */
export function prorate(amount: Fcfa, days: number, periodDays: number): Fcfa {
	assertFcfa(amount);
	if (!Number.isInteger(days) || !Number.isInteger(periodDays) || days < 0 || periodDays <= 0 || days > periodDays) {
		throw new RentScheduleError(`Prorata invalide : ${days} / ${periodDays} jours.`);
	}
	return Number((BigInt(amount) * BigInt(days)) / BigInt(periodDays));
}

/** Début de la k-ième période anniversaire d'un bail entré le `startOn`. */
export function anniversaryStart(startOn: string, k: number, monthsPerPeriod = 1): string {
	const [y, m, d] = ymd(startOn);
	return monthDay(y, m, k * monthsPerPeriod, d);
}

/** `date` est-elle un jour anniversaire de `startOn` (pour la périodicité donnée) ? */
export function isAnniversaryOf(date: string, startOn: string, monthsPerPeriod = 1): boolean {
	if (date < startOn) return false;
	const [sy, sm] = ymd(startOn);
	const [y, m] = ymd(date);
	const months = (y - sy) * 12 + (m - sm);
	return months % monthsPerPeriod === 0 && anniversaryStart(startOn, months / monthsPerPeriod, monthsPerPeriod) === date;
}

/** Fin d'un bail à durée déterminée de `months` mois : la veille du même jour, `months` mois plus tard. */
export function endOnFromDuration(startOn: string, months: number): string {
	if (!Number.isInteger(months) || months < 1) throw new RentScheduleError(`Durée invalide : ${months} mois.`);
	return addDays(addMonths(startOn, months), -1);
}

/** Dernière date de début de période à générer : fin du bail, ou 12 mois glissants pour un bail sans fin. */
export function scheduleUntil(lease: { endOn: string | null; duesStartOn: string }, today: string): string {
	if (lease.endOn) return lease.endOn;
	return addDays(addMonths(maxDate(today, lease.duesStartOn), ROLLING_HORIZON_MONTHS), -1);
}

function rateAt(rates: readonly RentRate[], date: string): RentRate {
	let found: RentRate | undefined;
	for (const r of rates) if (r.effectiveFrom <= date) found = r;
	if (!found) throw new RentScheduleError(`Aucun loyer en vigueur au ${date}.`);
	return found;
}

function checkInput(input: RentScheduleInput): void {
	const dates = { startOn: input.startOn, duesStartOn: input.duesStartOn, activatedOn: input.activatedOn, until: input.until };
	for (const [name, value] of Object.entries(dates)) if (!isIsoDate(value)) throw new RentScheduleError(`${name} invalide : ${value}`);
	if (input.endOn !== null && !isIsoDate(input.endOn)) throw new RentScheduleError(`endOn invalide : ${input.endOn}`);
	if (input.endOn !== null && input.endOn < input.startOn) throw new RentScheduleError('La fin du bail précède son début.');
	if (input.duesStartOn < input.startOn) throw new RentScheduleError('La facturation commence avant le bail.');
	if (input.endOn !== null && input.duesStartOn > input.endOn) throw new RentScheduleError('La facturation commence après la fin du bail.');
	if (!Number.isInteger(input.dueDay) || input.dueDay < 1 || input.dueDay > 28) throw new RentScheduleError('Jour d’échéance de 1 à 28.');
	const perPeriod = MONTHS_PER_PERIOD[input.periodicity];
	if (!Number.isInteger(input.advanceMonths) || input.advanceMonths < 0 || input.advanceMonths % perPeriod !== 0) {
		throw new RentScheduleError('Avance : un nombre entier de périodes.');
	}
	if (input.billingMode === 'anniversary' && !isAnniversaryOf(input.duesStartOn, input.startOn, perPeriod)) {
		throw new RentScheduleError('En mode anniversaire, la facturation commence un jour anniversaire de l’entrée.');
	}
	if (input.rates.length === 0) throw new RentScheduleError('Aucun loyer.');
	for (let i = 0; i < input.rates.length; i++) {
		const r = input.rates[i]!;
		if (!isIsoDate(r.effectiveFrom)) throw new RentScheduleError(`Date d’effet invalide : ${r.effectiveFrom}`);
		assertFcfa(r.rent);
		assertFcfa(r.charges);
		if (i > 0 && r.effectiveFrom <= input.rates[i - 1]!.effectiveFrom) throw new RentScheduleError('Dates d’effet non croissantes.');
	}
	if (input.rates[0]!.effectiveFrom > input.duesStartOn) throw new RentScheduleError('Aucun loyer en vigueur au début de la facturation.');
}

interface RawPeriod {
	start: string;
	end: string;
	/** Bornes de la période entière (mois ou trimestre civil, ou période anniversaire). */
	nominalStart: string;
	nominalEnd: string;
}

function rawPeriods(input: RentScheduleInput): RawPeriod[] {
	const perPeriod = MONTHS_PER_PERIOD[input.periodicity];
	const last = input.endOn !== null ? minDate(input.endOn, input.until) : input.until;
	const out: RawPeriod[] = [];
	if (input.billingMode === 'anniversary') {
		const [sy, sm] = ymd(input.startOn);
		const [by, bm] = ymd(input.duesStartOn);
		let k = ((by - sy) * 12 + (bm - sm)) / perPeriod;
		for (let start = anniversaryStart(input.startOn, k, perPeriod); start <= last;) {
			const next = anniversaryStart(input.startOn, k + 1, perPeriod);
			const nominalEnd = addDays(next, -1);
			out.push({ start, end: input.endOn !== null ? minDate(nominalEnd, input.endOn) : nominalEnd, nominalStart: start, nominalEnd });
			k += 1;
			start = next;
		}
		return out;
	}
	const [y, m] = ymd(input.duesStartOn);
	// Premier mois du bloc civil (mois, ou trimestre commençant en janvier, avril, juillet, octobre).
	let blockStart = monthDay(y, m - ((m - 1) % perPeriod), 0, 1);
	for (;;) {
		const start = maxDate(blockStart, input.duesStartOn);
		if (start > last) break;
		const [ny, nm] = ymd(blockStart);
		const nextBlock = monthDay(ny, nm, perPeriod, 1);
		const nominalEnd = addDays(nextBlock, -1);
		out.push({ start, end: input.endOn !== null ? minDate(nominalEnd, input.endOn) : nominalEnd, nominalStart: blockStart, nominalEnd });
		blockStart = nextBlock;
	}
	return out;
}

/** Date d'échéance normale d'une période (hors avance). */
function regularDueOn(input: RentScheduleInput, p: RawPeriod): string {
	if (input.billingMode === 'anniversary') return p.start;
	const [y, m] = ymd(p.nominalStart);
	const dueDate = monthDay(y, m, 0, input.dueDay);
	return minDate(maxDate(dueDate, p.start), p.end);
}

/** Génère les échéances d'un bail jusqu'à `until`. Déterministe : la clé d'une échéance est son début de période. */
export function generateRentSchedule(input: RentScheduleInput): RentDueDraft[] {
	checkInput(input);
	const periods = rawPeriods(input);
	let advanceLeft = input.advanceMonths / MONTHS_PER_PERIOD[input.periodicity];
	return periods.map((p, index) => {
		const partialStart = p.start !== p.nominalStart;
		const partialEnd = p.end !== p.nominalEnd;
		let prorated: boolean;
		if (input.billingMode === 'anniversary') prorated = false;
		else if (input.billingMode === 'calendar_full_first') prorated = index > 0 && partialEnd;
		else prorated = partialStart || partialEnd;
		// Premier mois incomplet en calendar_prorata : dû à l'entrée, hors avance.
		const entryProrata = input.billingMode === 'calendar_prorata' && index === 0 && partialStart;
		const isAdvance = !entryProrata && advanceLeft > 0;
		if (isAdvance) advanceLeft -= 1;
		const dueAtSignature = entryProrata || isAdvance;
		const rate = rateAt(input.rates, p.start);
		const days = daysBetween(p.start, p.end) + 1;
		const nominalDays = daysBetween(p.nominalStart, p.nominalEnd) + 1;
		const rent = prorated ? prorate(rate.rent, days, nominalDays) : rate.rent;
		const charges = prorated ? prorate(rate.charges, days, nominalDays) : rate.charges;
		const regular = regularDueOn(input, p);
		return {
			periodStart: p.start,
			periodEnd: p.end,
			dueOn: dueAtSignature ? minDate(input.activatedOn, regular) : regular,
			rent,
			charges,
			amountDue: rent + charges,
			prorated,
			isAdvance,
			dueAtSignature,
			leaseVersion: rate.version
		};
	});
}

/** Débuts de période possibles pour un changement de loyer : ceux de l'échéancier (jusqu'à `until`). */
export function periodStarts(input: RentScheduleInput): string[] {
	checkInput(input);
	return rawPeriods(input).map((p) => p.start);
}

/** Échéance déjà enregistrée, telle que la décrit `rent_dues`. */
export interface IssuedRentDue {
	periodStart: string;
	status: string;
	amountPaid: Fcfa;
	rent: Fcfa;
	charges: Fcfa;
	amountDue: Fcfa;
	leaseVersion: number;
}

/**
 * Une échéance est « émise » dès qu'elle n'est plus à venir (due, payée en partie ou en entier, en retard,
 * abandonnée) ou qu'elle a reçu un paiement : son montant ne change plus jamais.
 */
export function isIssued(due: Pick<IssuedRentDue, 'status' | 'amountPaid'>): boolean {
	return due.status !== 'upcoming' || due.amountPaid > 0;
}

export interface RentDueUpdate {
	periodStart: string;
	rent: Fcfa;
	charges: Fcfa;
	amountDue: Fcfa;
	leaseVersion: number;
}

/**
 * Après un changement de loyer : montants à réécrire, seulement pour les échéances encore à venir et sans paiement
 * dont le montant change. Les échéances émises restent telles quelles. Les périodes absentes de `existing` sont des
 * créations (même clé, `INSERT … ON CONFLICT DO NOTHING`), pas des mises à jour.
 */
export function rentDueUpdates(existing: readonly IssuedRentDue[], regenerated: readonly RentDueDraft[]): RentDueUpdate[] {
	const byStart = new Map(regenerated.map((d) => [d.periodStart, d]));
	const updates: RentDueUpdate[] = [];
	for (const row of existing) {
		if (isIssued(row)) continue;
		const next = byStart.get(row.periodStart);
		if (!next) continue;
		if (next.rent === row.rent && next.charges === row.charges && next.leaseVersion === row.leaseVersion) continue;
		updates.push({
			periodStart: row.periodStart,
			rent: next.rent,
			charges: next.charges,
			amountDue: next.amountDue,
			leaseVersion: next.leaseVersion
		});
	}
	return updates;
}

/** Codes de refus d'un changement de loyer. */
export type RentChangeBlocker = 'RENT_CHANGE_NOT_PERIOD_START' | 'RENT_CHANGE_ON_ISSUED_DUE' | 'RENT_CHANGE_OUT_OF_LEASE';

/**
 * Un changement de loyer prend effet au début d'une période du bail, jamais sur une échéance déjà émise.
 * `input` : l'échéancier actuel du bail, `until` couvrant la date d'effet.
 */
export function rentChangeBlocker(
	input: RentScheduleInput,
	effectiveFrom: string,
	existing: readonly IssuedRentDue[]
): RentChangeBlocker | null {
	if (!isIsoDate(effectiveFrom) || effectiveFrom < input.duesStartOn || (input.endOn !== null && effectiveFrom > input.endOn)) {
		return 'RENT_CHANGE_OUT_OF_LEASE';
	}
	const starts = periodStarts({ ...input, until: maxDate(input.until, effectiveFrom) });
	if (!starts.includes(effectiveFrom)) return 'RENT_CHANGE_NOT_PERIOD_START';
	if (existing.some((d) => d.periodStart >= effectiveFrom && isIssued(d))) return 'RENT_CHANGE_ON_ISSUED_DUE';
	return null;
}
