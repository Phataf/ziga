/**
 * Téléphones du Burkina Faso : stockés en E.164 (« +226XXXXXXXX », CLAUDE.md §6),
 * affichés « +226 70 12 34 56 ». Le numéro national a 8 chiffres.
 */
import { z } from 'zod';
import { NBSP } from './money.js';

export const BF_COUNTRY_CODE = '226';

/**
 * Premiers chiffres admis : 0 (nouvelles séries mobiles), 2 (fixe), 5, 6 et 7 (mobiles).
 * La liste exacte des séries attribuées par l'ARCEP est à confirmer ; on refuse seulement ce qui est sûrement faux.
 */
const NATIONAL = /^[02567]\d{7}$/;

/**
 * Normalise un numéro burkinabè en E.164.
 * Accepte « 70123456 », « 70 12 34 56 », « 0022670123456 », « 22670123456 », « +226 70-12-34-56 ».
 * Renvoie `null` si ce n'est pas un numéro du Burkina à 8 chiffres.
 */
export function toE164(input: string): string | null {
	const trimmed = input.trim();
	if (!/^[+\d\s().  -]+$/.test(trimmed)) return null;
	let digits = trimmed.replace(/\D/g, '');
	const international = trimmed.startsWith('+') || digits.startsWith('00');
	if (digits.startsWith('00')) digits = digits.slice(2);
	if (digits.length === 11 && digits.startsWith(BF_COUNTRY_CODE)) digits = digits.slice(3);
	else if (international) return null; // indicatif d'un autre pays
	return NATIONAL.test(digits) ? `+${BF_COUNTRY_CODE}${digits}` : null;
}

export function isBfPhone(input: string): boolean {
	return toE164(input) !== null;
}

/** « +22670123456 » → « +226 70 12 34 56 » (espaces insécables). Renvoie l'entrée telle quelle si elle n'est pas reconnue. */
export function formatPhone(input: string): string {
	const e164 = toE164(input);
	if (!e164) return input;
	const n = e164.slice(4);
	return ['+226', n.slice(0, 2), n.slice(2, 4), n.slice(4, 6), n.slice(6, 8)].join(NBSP);
}

/** Numéro pour un lien wa.me (chiffres seuls, indicatif compris). */
export function waNumber(input: string): string | null {
	const e164 = toE164(input);
	return e164 ? e164.slice(1) : null;
}

/** Schéma Zod : accepte toutes les saisies reconnues et renvoie l'E.164. */
export const phoneSchema = z.string().transform((value, ctx) => {
	const e164 = toE164(value);
	if (!e164) {
		ctx.addIssue({ code: 'custom', message: 'Numéro du Burkina Faso à 8 chiffres attendu.' });
		return z.NEVER;
	}
	return e164;
});
