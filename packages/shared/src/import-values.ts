/**
 * Import Excel (lot 11) : lecture des valeurs d'une cellule, telles qu'un registre tenu à la main les écrit.
 * Chaque fonction rend `{ value }` (null pour une cellule vide) ou `{ error }`, un message en français simple qui dit
 * quoi écrire ; la ligne et la colonne sont ajoutées par l'appelant (`import-rows.ts`). Fonctions pures.
 */
import { formatDate, isIsoDate } from './dates.js';
import { placeNameKey } from './geography.js';
import { isFcfa } from './money.js';
import { toE164 } from './phone.js';

/** Valeur d'une cellule rendue par le lecteur (`.xlsx`) ou par le CSV (toujours du texte). */
export type CellValue = string | number | boolean | Date | null;

export type Parsed<T> = { value: T | null } | { error: string };

const blank = (v: CellValue | undefined): boolean => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/** Espaces de toutes sortes (insécable, fine insécable) ramenés à une espace ordinaire. */
const spaces = (s: string) => s.replace(/[\s\u00a0\u202f]+/gu, ' ').trim();

/** Texte d'une cellule : espaces réduits ; un nombre sans « .0 » ; une date en jj/mm/aaaa. */
export function importText(v: CellValue | undefined): string | null {
	if (blank(v)) return null;
	if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : formatDate(v.toISOString().slice(0, 10));
	if (typeof v === 'number') return String(v);
	if (typeof v === 'boolean') return v ? 'Oui' : 'Non';
	return spaces(String(v)) || null;
}

// ---------------------------------------------------------------- montants

export const AMOUNT_ERROR = 'montant en chiffres attendu, par exemple 75 000.';
export const AMOUNT_DECIMAL_ERROR = 'montant entier attendu, sans centimes.';
export const AMOUNT_NEGATIVE_ERROR = 'un montant ne peut pas être négatif.';

/**
 * Montant en FCFA (règle 2) : « 75.000 », « 75 000 F », « 75000 FCFA », « 75,000 », « 75 000,00 » → 75000.
 * Un point ou une virgule suivi de groupes de trois chiffres sépare les milliers ; sinon c'est une décimale, admise
 * seulement si elle est nulle (« ,00 »). Négatif, décimal ou autre devise : refusé.
 */
export function parseImportAmount(v: CellValue | undefined): Parsed<number> {
	if (blank(v)) return { value: null };
	if (typeof v === 'number') {
		if (v < 0) return { error: AMOUNT_NEGATIVE_ERROR };
		if (!Number.isInteger(v)) return { error: AMOUNT_DECIMAL_ERROR };
		return isFcfa(v) ? { value: v } : { error: AMOUNT_ERROR };
	}
	if (typeof v !== 'string') return { error: AMOUNT_ERROR };
	let s = spaces(v)
		.replace(/^(xof|fcfa|f\s?cfa)\s*/i, '')
		.replace(/\s*(fcfa|f\s?cfa|cfa|xof|f)\.?$/i, '')
		.trim();
	if (/^-/.test(s)) return { error: AMOUNT_NEGATIVE_ERROR };
	s = s.replace(/ /g, '');
	// Séparateurs des milliers, tous identiques : « 1.500.000 », « 75,000 ».
	if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replaceAll('.', '');
	else if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replaceAll(',', '');
	const decimal = /^(\d+)[.,](\d+)$/.exec(s);
	if (decimal) {
		if (!/^0+$/.test(decimal[2]!)) return { error: AMOUNT_DECIMAL_ERROR };
		s = decimal[1]!;
	}
	if (!/^\d{1,16}$/.test(s)) return { error: AMOUNT_ERROR };
	const value = Number.parseInt(s, 10);
	return isFcfa(value) ? { value } : { error: AMOUNT_ERROR };
}

// ---------------------------------------------------------------- téléphones

export const PHONE_ERROR = '8 chiffres attendus, par exemple 70 12 34 56.';
export const PHONE_TWO_NUMBERS_ERROR = 'un seul numéro par cellule ; mettez le second dans « Téléphone 2 ».';

/**
 * Téléphone en E.164 (« +22670123456 »), quelle que soit l'écriture : espaces, tirets, points, « +226 », « 00226 »,
 * « 226 » sans « + », « (+226) », « Tél : », ou cellule nombre (Excel efface la mise en forme d'un numéro).
 */
export function parseImportPhone(v: CellValue | undefined): Parsed<string> {
	if (blank(v)) return { value: null };
	if (typeof v === 'number') {
		if (!Number.isSafeInteger(v) || v < 0) return { error: PHONE_ERROR };
		return withPhone(toE164(String(v)));
	}
	if (typeof v !== 'string') return { error: PHONE_ERROR };
	const s = spaces(v);
	if (/[/;]|\bou\b|\bet\b/i.test(s)) {
		// Deux numéros dans la même cellule (« 70123456 / 76543210 ») : ne jamais en garder un au hasard.
		const groups = s.split(/[/;]|\bou\b|\bet\b/i).filter((p) => /\d{6,}/.test(p.replace(/\D/g, '')));
		if (groups.length > 1) return { error: PHONE_TWO_NUMBERS_ERROR };
	}
	const cleaned = s
		.replace(/^(t[ée]l[ée]?phone|t[ée]l|cel+|mob(ile)?|portable)\s*\.?\s*:?\s*/i, '')
		.replace(/^\(\s*(\+?\d{1,3})\s*\)/, '$1')
		.trim();
	return withPhone(toE164(cleaned));
}

function withPhone(e164: string | null): Parsed<string> {
	return e164 ? { value: e164 } : { error: PHONE_ERROR };
}

// ---------------------------------------------------------------- dates

export const DATE_ERROR = 'date attendue au format jj/mm/aaaa, par exemple 01/03/2021.';

/** Premier et dernier numéros de série admis : 01/01/1950 et 31/12/2100 (calendrier 1900 d'Excel). */
const SERIAL_MIN = 18_264;
const SERIAL_MAX = 73_415;
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

function isoOf(y: number, m: number, d: number): string | null {
	const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
	return isIsoDate(iso) ? iso : null;
}

function fromSerial(n: number): string | null {
	if (!Number.isFinite(n) || n < SERIAL_MIN || n > SERIAL_MAX) return null;
	return new Date(EXCEL_EPOCH + Math.floor(n) * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Date en aaaa-mm-jj : « jj/mm/aaaa » (aussi « j/m/aaaa », tirets, points), « aaaa-mm-jj », numéro de série Excel
 * (nombre ou texte), ou cellule date du lecteur. Jamais mm/jj ; une année sur deux chiffres est refusée.
 */
export function parseImportDate(v: CellValue | undefined): Parsed<string> {
	if (blank(v)) return { value: null };
	if (v instanceof Date) {
		if (Number.isNaN(v.getTime())) return { error: DATE_ERROR };
		return { value: v.toISOString().slice(0, 10) };
	}
	if (typeof v === 'number') return toParsedDate(fromSerial(v));
	if (typeof v !== 'string') return { error: DATE_ERROR };
	const s = v.trim();
	let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
	if (m) return toParsedDate(isoOf(+m[3]!, +m[2]!, +m[1]!));
	m = /^(\d{4})-(\d{2})-(\d{2})(T[\d:.]+Z?)?$/.exec(s);
	if (m) return toParsedDate(isoOf(+m[1]!, +m[2]!, +m[3]!));
	if (/^\d{5}(\.\d+)?$/.test(s)) return toParsedDate(fromSerial(Number(s)));
	return { error: DATE_ERROR };
}

function toParsedDate(iso: string | null): Parsed<string> {
	return iso ? { value: iso } : { error: DATE_ERROR };
}

// ---------------------------------------------------------------- nombres, pourcentages, oui ou non, listes

export function parseImportInteger(v: CellValue | undefined, min: number, max: number): Parsed<number> {
	if (blank(v)) return { value: null };
	const error = { error: `nombre entier de ${min} à ${max} attendu.` };
	const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : Number.NaN;
	if (!Number.isInteger(n) || n < min || n > max) return error;
	return { value: n };
}

export const PERCENT_ERROR = 'pourcentage de 0 à 100 attendu, par exemple 10 %.';

/**
 * Pourcentage en points de base (10 % → 1000) : « 10 », « 10 % », « 8,5 % », deux décimales au plus. Une cellule
 * nombre entre 0 et 1 (exclus) est une cellule mise en forme « pourcentage » d'Excel : 0,1 vaut 10 %.
 */
export function parseImportPercent(v: CellValue | undefined): Parsed<number> {
	if (blank(v)) return { value: null };
	let n: number;
	if (typeof v === 'number') {
		n = v > 0 && v < 1 ? v * 100 : v;
	} else if (typeof v === 'string') {
		const s = v.replace(/\s|%/g, '').replace(',', '.');
		if (!/^\d+(\.\d{1,2})?$/.test(s)) return { error: PERCENT_ERROR };
		n = Number(s);
	} else {
		return { error: PERCENT_ERROR };
	}
	const bp = Math.round(n * 100);
	if (!Number.isFinite(n) || n < 0 || n > 100 || Math.abs(bp - n * 100) > 1e-6) return { error: PERCENT_ERROR };
	return { value: bp };
}

export const BOOLEAN_ERROR = '« Oui » ou « Non » attendu.';
const YES = new Set(['oui', 'o', 'x', 'vrai', '1', 'yes', 'y']);
const NO = new Set(['non', 'n', 'faux', '0', 'no']);

export function parseImportBoolean(v: CellValue | undefined): Parsed<boolean> {
	if (blank(v)) return { value: null };
	if (typeof v === 'boolean') return { value: v };
	if (typeof v === 'number') return v === 1 ? { value: true } : v === 0 ? { value: false } : { error: BOOLEAN_ERROR };
	const key = placeNameKey(String(v));
	if (YES.has(key)) return { value: true };
	if (NO.has(key)) return { value: false };
	return { error: BOOLEAN_ERROR };
}

export interface ImportChoice<T extends string = string> {
	value: T;
	label: string;
	aliases?: readonly string[];
}

/** Clé de comparaison d'un libellé : sans accents ni casse, apostrophes et ponctuation ramenées à une espace. */
export function labelKey(s: string): string {
	return placeNameKey(s.replace(/[’'`´]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' '));
}

/** Valeur d'une liste fermée, par son libellé, sa valeur ou une variante courante. */
export function parseImportChoice<T extends string>(v: CellValue | undefined, choices: readonly ImportChoice<T>[]): Parsed<T> {
	if (blank(v)) return { value: null };
	const key = labelKey(String(v));
	const found = choices.find(
		(c) => labelKey(c.label) === key || labelKey(c.value) === key || (c.aliases ?? []).some((a) => labelKey(a) === key)
	);
	if (found) return { value: found.value };
	return { error: `valeur de la liste attendue : ${choices.map((c) => c.label).join(', ')}.` };
}
