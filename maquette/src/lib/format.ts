/**
 * Formats locaux (CLAUDE.md §5.2 et §6) : montants en FCFA entiers,
 * téléphones burkinabè en E.164, dates jj/mm/aaaa.
 */

/** Espace fine insécable (U+202F), séparateur des milliers. */
export const THIN_NBSP = ' ';
/** Espace insécable (U+00A0), entre le nombre et l'unité. */
export const NBSP = ' ';

function assertAmount(amount: number): void {
	if (!Number.isSafeInteger(amount)) {
		throw new RangeError(`Montant FCFA invalide (entier attendu) : ${amount}`);
	}
}

/** 75000 → « 75 000 » (espace fine insécable). */
export function formatNumber(amount: number): string {
	assertAmount(amount);
	const sign = amount < 0 ? '-' : '';
	const digits = Math.abs(amount).toString();
	return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, THIN_NBSP);
}

/** 75000 → « 75 000 FCFA ». */
export function formatFCFA(amount: number): string {
	return `${formatNumber(amount)}${NBSP}FCFA`;
}

/**
 * Lit un montant saisi au clavier (« 75 000 », « 75000 ») et renvoie un entier,
 * ou `null` si la saisie n'est pas un entier positif ou nul.
 */
export function parseAmount(input: string): number | null {
	const cleaned = input.replace(/[\s  .]/g, '');
	if (!/^\d{1,12}$/.test(cleaned)) return null;
	return Number.parseInt(cleaned, 10);
}

/**
 * Normalise un numéro burkinabè en E.164 (« +226XXXXXXXX »).
 * Accepte « 70 12 34 56 », « 0022670123456 », « +226 70-12-34-56 ».
 * Renvoie `null` si le numéro n'a pas 8 chiffres nationaux.
 */
export function toE164(input: string): string | null {
	let digits = input.replace(/[^\d+]/g, '');
	if (digits.startsWith('+')) digits = digits.slice(1);
	else if (digits.startsWith('00')) digits = digits.slice(2);
	if (digits.length === 11 && digits.startsWith('226')) digits = digits.slice(3);
	if (!/^\d{8}$/.test(digits)) return null;
	return `+226${digits}`;
}

/** « +22670123456 » → « +226 70 12 34 56 ». Renvoie l'entrée telle quelle si elle n'est pas reconnue. */
export function formatPhone(input: string): string {
	const e164 = toE164(input);
	if (!e164) return input;
	const n = e164.slice(4);
	return `+226${NBSP}${n.slice(0, 2)}${NBSP}${n.slice(2, 4)}${NBSP}${n.slice(4, 6)}${NBSP}${n.slice(6, 8)}`;
}

/** Numéro utilisable dans un lien wa.me (chiffres seuls, indicatif compris). */
export function waNumber(input: string): string {
	const e164 = toE164(input);
	return e164 ? e164.slice(1) : input.replace(/\D/g, '');
}

/** Date locale du jour au format ISO « aaaa-mm-jj ». */
export function isoToday(now: Date = new Date()): string {
	return isoDate(now);
}

export function isoDate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

/** « 2026-11-07 » → « 07/11/2026 ». */
export function formatDate(iso: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
	if (!match) throw new RangeError(`Date ISO invalide : ${iso}`);
	return `${match[3]}/${match[2]}/${match[1]}`;
}

const MONTHS = [
	'janvier',
	'février',
	'mars',
	'avril',
	'mai',
	'juin',
	'juillet',
	'août',
	'septembre',
	'octobre',
	'novembre',
	'décembre'
];

/** « 2026-10 » → « octobre 2026 ». */
export function formatMonth(period: string): string {
	const match = /^(\d{4})-(\d{2})/.exec(period);
	if (!match) throw new RangeError(`Période invalide : ${period}`);
	return `${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

/** « 2026-10 » → « Octobre 2026 ». */
export function formatMonthTitle(period: string): string {
	const s = formatMonth(period);
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Nombre de jours entre deux dates ISO (b − a). */
export function daysBetween(a: string, b: string): number {
	const da = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
	const db = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
	return Math.round((db - da) / 86_400_000);
}

/** « 1 jour », « 23 jours ». */
export function formatDays(n: number): string {
	return `${n}${NBSP}jour${n > 1 ? 's' : ''}`;
}
