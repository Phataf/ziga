/**
 * Dates (CLAUDE.md §6) : `timestamptz` en UTC pour les instants, `date` (« aaaa-mm-jj ») pour les échéances.
 * Affichage « jj/mm/aaaa », à l'heure de Ouagadougou (UTC+0, sans heure d'été).
 */
export const TIME_ZONE = 'Africa/Ouagadougou';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: string): boolean {
	const m = ISO_DATE.exec(value);
	if (!m) return false;
	const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
	return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}

/** Date calendaire du jour (ou d'un instant) à Ouagadougou, au format « aaaa-mm-jj ». */
export function toIsoDate(instant: Date = new Date()): string {
	const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
		instant
	);
	return parts; // en-CA donne « aaaa-mm-jj »
}

/** « 2026-11-07 » ou un instant → « 07/11/2026 ». */
export function formatDate(value: string | Date): string {
	const iso = typeof value === 'string' ? value.slice(0, 10) : toIsoDate(value);
	if (!isIsoDate(iso)) throw new RangeError(`Date invalide : ${String(value)}`);
	const [y, m, d] = iso.split('-');
	return `${d}/${m}/${y}`;
}

/** « 07/11/2026 » → « 2026-11-07 », ou `null` si la date n'existe pas. */
export function parseDate(input: string): string | null {
	const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(input.trim());
	if (!m) return null;
	const iso = `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
	return isIsoDate(iso) ? iso : null;
}

/** Ajoute (ou retire) des jours à une date aaaa-mm-jj. */
export function addDays(iso: string, days: number): string {
	if (!isIsoDate(iso)) throw new RangeError(`Date invalide : ${iso}`);
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/** Nombre de jours de `from` à `to` (dates aaaa-mm-jj ; négatif si `to` est avant). */
export function daysBetween(from: string, to: string): number {
	return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Nombre de jours du mois `month` (1 à 12) de l'année `year`. */
export function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Date du jour `day` du mois situé `months` mois après (year, month), ramenée au dernier jour d'un mois plus court. */
export function monthDay(year: number, month: number, months: number, day: number): string {
	const index = year * 12 + (month - 1) + months;
	const y = Math.floor(index / 12);
	const m = index - y * 12 + 1;
	const d = Math.min(day, daysInMonth(y, m));
	return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Ajoute (ou retire) des mois à une date aaaa-mm-jj, au même jour ou au dernier jour d'un mois plus court. */
export function addMonths(iso: string, months: number): string {
	if (!isIsoDate(iso)) throw new RangeError(`Date invalide : ${iso}`);
	const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
	return monthDay(y, m, months, d);
}
