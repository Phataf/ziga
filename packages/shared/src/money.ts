/**
 * Montants en francs CFA (CLAUDE.md règle 2) : entiers, jamais de flottant, jamais de centimes,
 * jamais négatifs. Une contre-écriture est une opération à part, pas un montant négatif.
 */
import { z } from 'zod';

/** Un montant en FCFA : entier positif ou nul. `bigint` en base, `number` entier côté TypeScript. */
export type Fcfa = number;

/** Espace fine insécable (U+202F), séparateur des milliers. */
export const THIN_NBSP = '\u202f';
/** Espace insécable (U+00A0), entre le nombre et l'unité. */
export const NBSP = '\u00a0';

/** Plus grand montant représentable exactement : 9 007 199 254 740 991 FCFA. */
export const MAX_FCFA = Number.MAX_SAFE_INTEGER;

/** Schéma Zod d'un montant, réutilisé par l'API et par les formulaires. */
export const fcfaSchema = z
	.number({ error: 'Le montant doit être un nombre.' })
	.int({ error: 'Le montant doit être un entier, sans centimes.' })
	.nonnegative({ error: 'Le montant ne peut pas être négatif.' })
	.max(MAX_FCFA, { error: 'Montant trop grand.' });

export class InvalidAmountError extends RangeError {
	constructor(value: unknown) {
		super(`Montant FCFA invalide : ${String(value)} (entier positif ou nul attendu).`);
		this.name = 'InvalidAmountError';
	}
}

export function isFcfa(value: unknown): value is Fcfa {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Vérifie un montant et le renvoie ; refuse les décimales, les négatifs et les valeurs non sûres. */
export function assertFcfa(value: unknown): Fcfa {
	if (!isFcfa(value)) throw new InvalidAmountError(value);
	return value;
}

/** 75000 → « 75 000 » (espace fine insécable). */
export function formatFcfaNumber(amount: Fcfa): string {
	return assertFcfa(amount)
		.toString()
		.replace(/\B(?=(\d{3})+(?!\d))/g, THIN_NBSP);
}

/** 75000 → « 75 000 FCFA » : espace fine insécable entre les milliers, espace insécable avant l'unité. */
export function formatFcfa(amount: Fcfa): string {
	return `${formatFcfaNumber(amount)}${NBSP}FCFA`;
}

/**
 * Montant pour un PDF dessiné par pdf-lib avec ses polices standard (encodage WinAnsi, reçus et relevés) : ces polices
 * n'ont pas l'espace fine insécable (U+202F) et pdf-lib la refuse ; l'espace insécable (U+00A0) la remplace, dans ces
 * documents seulement. Les écrans et les contrats (LibreOffice) gardent U+202F, vérifié par les tests de rendu.
 */
export function formatFcfaForPdf(amount: Fcfa): string {
	return formatFcfa(amount).replaceAll(THIN_NBSP, NBSP);
}

/** Signe moins typographique (U+2212), pour les montants à déduire d'un relevé. */
export const MINUS_SIGN = '\u2212';

/**
 * Montant signé d'un relevé (lot 10) : « 75 000 FCFA », « −15 000 FCFA » (signe moins U+2212). Une somme négative
 * n'est jamais stockée telle quelle dans un registre (règle 2) : elle n'apparaît qu'à l'affichage d'un total calculé.
 */
export function formatSignedFcfa(amount: number): string {
	if (!Number.isSafeInteger(amount)) throw new InvalidAmountError(amount);
	return amount < 0 ? `${MINUS_SIGN}${formatFcfa(-amount)}` : formatFcfa(amount);
}

/** Même chose pour un PDF de pdf-lib : sans U+202F ni U+2212 (absents de WinAnsi), un trait d'union à la place. */
export function formatSignedFcfaForPdf(amount: number): string {
	if (!Number.isSafeInteger(amount)) throw new InvalidAmountError(amount);
	return amount < 0 ? `-${formatFcfaForPdf(-amount)}` : formatFcfaForPdf(amount);
}

/**
 * Lit un montant saisi (« 75 000 », « 75000 », « 75 000 FCFA ») et renvoie un entier,
 * ou `null` si la saisie n'est pas un entier positif ou nul : « 75 000,50 » et « -5 000 » sont refusés.
 */
export function parseFcfa(input: string): Fcfa | null {
	const cleaned = input
		.replace(/fcfa|f\s*cfa|xof/gi, '')
		.replace(/[\s.]/g, '')
		.trim();
	if (!/^\d{1,16}$/.test(cleaned)) return null;
	const value = Number.parseInt(cleaned, 10);
	return isFcfa(value) ? value : null;
}
