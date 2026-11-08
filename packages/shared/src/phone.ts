/**
 * Téléphones : stockés en E.164 (« +22670123456 », CLAUDE.md §6). Tout numéro E.164 valide est accepté,
 * quel que soit le pays (propriétaires de la diaspora, D13) ; le Burkina Faso (+226) est le pays par défaut,
 * et ses numéros nationaux (8 chiffres) sont vérifiés plus finement.
 */
import { z } from 'zod';
import { NBSP } from './money.js';

export const BF_COUNTRY_CODE = '226';

export interface Country {
	/** Code ISO 3166-1 alpha-2. */
	iso: string;
	name: string;
	/** Indicatif sans « + ». */
	code: string;
	/** Le « 0 » initial d'un numéro national est un préfixe d'appel à retirer (France : 06… → +33 6…). */
	trunkZero: boolean;
}

/**
 * Pays proposés dans le formulaire : le Burkina Faso d'abord, puis ses voisins et les pays de la diaspora.
 * Tout autre pays reste possible en saisissant le numéro complet avec « + ».
 */
export const COUNTRIES: Country[] = [
	{ iso: 'BF', name: 'Burkina Faso', code: '226', trunkZero: false },
	{ iso: 'CI', name: 'Côte d’Ivoire', code: '225', trunkZero: false },
	{ iso: 'ML', name: 'Mali', code: '223', trunkZero: false },
	{ iso: 'NE', name: 'Niger', code: '227', trunkZero: false },
	{ iso: 'TG', name: 'Togo', code: '228', trunkZero: false },
	{ iso: 'BJ', name: 'Bénin', code: '229', trunkZero: false },
	{ iso: 'GH', name: 'Ghana', code: '233', trunkZero: true },
	{ iso: 'SN', name: 'Sénégal', code: '221', trunkZero: false },
	{ iso: 'GN', name: 'Guinée', code: '224', trunkZero: false },
	{ iso: 'CM', name: 'Cameroun', code: '237', trunkZero: false },
	{ iso: 'GA', name: 'Gabon', code: '241', trunkZero: false },
	{ iso: 'NG', name: 'Nigeria', code: '234', trunkZero: true },
	{ iso: 'MA', name: 'Maroc', code: '212', trunkZero: true },
	{ iso: 'FR', name: 'France', code: '33', trunkZero: true },
	{ iso: 'BE', name: 'Belgique', code: '32', trunkZero: true },
	{ iso: 'CH', name: 'Suisse', code: '41', trunkZero: true },
	{ iso: 'DE', name: 'Allemagne', code: '49', trunkZero: true },
	{ iso: 'IT', name: 'Italie', code: '39', trunkZero: false },
	{ iso: 'ES', name: 'Espagne', code: '34', trunkZero: false },
	{ iso: 'GB', name: 'Royaume-Uni', code: '44', trunkZero: true },
	{ iso: 'NL', name: 'Pays-Bas', code: '31', trunkZero: true },
	{ iso: 'US', name: 'États-Unis, Canada', code: '1', trunkZero: false },
	{ iso: 'AE', name: 'Émirats arabes unis', code: '971', trunkZero: true },
	{ iso: 'SA', name: 'Arabie saoudite', code: '966', trunkZero: true },
	{ iso: 'CN', name: 'Chine', code: '86', trunkZero: true }
];

/** Numéro national du Burkina : 8 chiffres ; séries 0 (nouvelles séries mobiles), 2 (fixe), 5, 6 et 7. */
const BF_NATIONAL = /^[02567]\d{7}$/;
/** E.164 : 15 chiffres au plus (indicatif compris), sans 0 initial ; 8 au moins pour écarter les saisies tronquées. */
const E164_DIGITS = /^[1-9]\d{7,14}$/;
const ALLOWED = /^[+\d\s().\u00a0\u202f-]+$/u;

/** Pays d'un numéro E.164, d'après l'indicatif le plus long qui correspond. */
export function countryOf(e164: string): Country | undefined {
	const digits = e164.replace(/^\+/, '');
	return [...COUNTRIES].sort((a, b) => b.code.length - a.code.length).find((c) => digits.startsWith(c.code));
}

function checkInternational(digits: string): string | null {
	if (!E164_DIGITS.test(digits)) return null;
	if (digits.startsWith(BF_COUNTRY_CODE) && !BF_NATIONAL.test(digits.slice(3))) return null;
	return `+${digits}`;
}

/**
 * Normalise un numéro en E.164.
 * - Avec « + » ou « 00 » : numéro international, de n'importe quel pays.
 * - Sinon : numéro national du pays choisi (par défaut le Burkina Faso, 8 chiffres).
 * Renvoie `null` si le numéro n'est pas valide.
 */
export function toE164(input: string, countryCode: string = BF_COUNTRY_CODE): string | null {
	const trimmed = input.trim();
	if (!trimmed || !ALLOWED.test(trimmed)) return null;
	let digits = trimmed.replace(/\D/g, '');
	if (trimmed.startsWith('+')) return checkInternational(digits);
	if (digits.startsWith('00')) return checkInternational(digits.slice(2));

	if (countryCode === BF_COUNTRY_CODE) {
		// « 22670123456 » : indicatif écrit sans « + ».
		if (digits.length === 11 && digits.startsWith(BF_COUNTRY_CODE)) digits = digits.slice(3);
		return BF_NATIONAL.test(digits) ? `+${BF_COUNTRY_CODE}${digits}` : null;
	}
	const country = COUNTRIES.find((c) => c.code === countryCode);
	if (!country && !/^[1-9]\d{0,2}$/.test(countryCode)) return null;
	if (country?.trunkZero && digits.startsWith('0')) digits = digits.slice(1);
	return checkInternational(`${countryCode}${digits}`);
}

export function isPhone(input: string, countryCode: string = BF_COUNTRY_CODE): boolean {
	return toE164(input, countryCode) !== null;
}

/** Regroupe des chiffres par deux (« 70 12 34 56 »), le premier seul si leur nombre est impair (« 6 12 34 56 78 »). */
function pairs(digits: string): string[] {
	const out: string[] = [];
	let i = digits.length % 2;
	if (i) out.push(digits.slice(0, 1));
	for (; i < digits.length; i += 2) out.push(digits.slice(i, i + 2));
	return out;
}

/**
 * Affichage lisible, avec des espaces insécables : « +226 70 12 34 56 », « +33 6 12 34 56 78 », « +1 514 555 0123 ».
 * Renvoie l'entrée telle quelle si elle n'est pas reconnue.
 */
export function formatPhone(input: string, countryCode: string = BF_COUNTRY_CODE): string {
	const e164 = toE164(input, countryCode);
	if (!e164) return input;
	const country = countryOf(e164);
	if (!country) return e164;
	const national = e164.slice(1 + country.code.length);
	const groups = country.code === '1' ? [national.slice(0, 3), national.slice(3, 6), national.slice(6)] : pairs(national);
	return [`+${country.code}`, ...groups].join(NBSP);
}

/** Numéro pour un lien wa.me (chiffres seuls, indicatif compris). */
export function waNumber(input: string, countryCode: string = BF_COUNTRY_CODE): string | null {
	const e164 = toE164(input, countryCode);
	return e164 ? e164.slice(1) : null;
}

export const PHONE_INVALID_MESSAGE = 'Numéro de téléphone invalide.';

/**
 * Schéma Zod : accepte un E.164 de n'importe quel pays ou un numéro national du Burkina,
 * et renvoie l'E.164. Le formulaire envoie déjà l'E.164 du pays choisi.
 */
export const phoneSchema = z.string().transform((value, ctx) => {
	const e164 = toE164(value);
	if (!e164) {
		ctx.addIssue({ code: 'custom', message: PHONE_INVALID_MESSAGE });
		return z.NEVER;
	}
	return e164;
});
