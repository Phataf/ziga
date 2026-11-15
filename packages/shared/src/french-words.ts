/**
 * Nombres et montants en toutes lettres, pour les contrats (lot 08 bis) : « soixante-quinze mille francs CFA ».
 *
 * Orthographe TRADITIONNELLE (et non celle des rectifications de 1990, qui mettrait des traits d'union partout :
 * « soixante-quinze-mille ») :
 * - trait d'union entre dizaines et unités sous cent, sauf avec « et » : « vingt et un », « soixante et onze »,
 *   mais « quatre-vingt-un » et « quatre-vingt-onze » (sans « et ») ;
 * - « vingt » (dans « quatre-vingts ») et « cent » prennent un s quand ils sont multipliés et terminent le nombre,
 *   ou devant « million », « milliard »… qui sont des noms : « quatre-vingts », « deux cents », « deux cents millions » ;
 *   ils restent invariables devant un autre nombre, « mille » compris : « quatre-vingt mille », « deux cent mille » ;
 * - « mille » est invariable et ne prend jamais « un » devant lui : « mille », « deux mille » ;
 * - « million », « milliard », « billion », « billiard » sont des noms : « un million », « deux millions ».
 */
import { assertFcfa, type Fcfa } from './money.js';

const UNITS = [
	'zéro',
	'un',
	'deux',
	'trois',
	'quatre',
	'cinq',
	'six',
	'sept',
	'huit',
	'neuf',
	'dix',
	'onze',
	'douze',
	'treize',
	'quatorze',
	'quinze',
	'seize'
] as const;

const TENS: Record<number, string> = { 2: 'vingt', 3: 'trente', 4: 'quarante', 5: 'cinquante', 6: 'soixante' };

/**
 * 1 à 99. `final` : le nombre termine l'expression ou précède un nom (million…), et « quatre-vingts » prend alors
 * son s ; devant « mille », il ne le prend pas.
 */
function belowHundred(n: number, final: boolean): string {
	if (n <= 16) return UNITS[n]!;
	if (n < 20) return `dix-${UNITS[n - 10]}`;
	const tens = Math.floor(n / 10);
	const unit = n % 10;
	if (tens === 7 || tens === 9) {
		// 70 à 79 : soixante-dix, soixante et onze, soixante-douze ; 90 à 99 : quatre-vingt-dix, quatre-vingt-onze.
		const base = tens === 7 ? 'soixante' : 'quatre-vingt';
		const rest = 10 + unit;
		if (tens === 7 && unit === 1) return 'soixante et onze';
		return `${base}-${belowHundred(rest, true)}`;
	}
	if (tens === 8) return unit === 0 ? (final ? 'quatre-vingts' : 'quatre-vingt') : `quatre-vingt-${UNITS[unit]}`;
	const word = TENS[tens]!;
	if (unit === 0) return word;
	if (unit === 1) return `${word} et un`;
	return `${word}-${UNITS[unit]}`;
}

/** 1 à 999 (même règle `final` pour « cents » et « quatre-vingts »). */
function belowThousand(n: number, final: boolean): string {
	const hundreds = Math.floor(n / 100);
	const rest = n % 100;
	const parts: string[] = [];
	if (hundreds === 1) parts.push('cent');
	else if (hundreds > 1) parts.push(rest === 0 && final ? `${UNITS[hundreds]} cents` : `${UNITS[hundreds]} cent`);
	if (rest > 0) parts.push(belowHundred(rest, final));
	return parts.join(' ');
}

/** Échelles nommées (longue échelle française), de la plus grande à la plus petite. */
const SCALES = [
	{ value: 1_000_000_000_000_000, singular: 'billiard', plural: 'billiards' },
	{ value: 1_000_000_000_000, singular: 'billion', plural: 'billions' },
	{ value: 1_000_000_000, singular: 'milliard', plural: 'milliards' },
	{ value: 1_000_000, singular: 'million', plural: 'millions' }
] as const;

/** Un entier positif ou nul en toutes lettres : 75 000 → « soixante-quinze mille ». */
export function numberInFrenchWords(value: number): string {
	const n = assertFcfa(value);
	if (n === 0) return UNITS[0];
	const parts: string[] = [];
	let rest = n;
	for (const scale of SCALES) {
		const count = Math.floor(rest / scale.value);
		if (count > 0) {
			// Un nom suit : « deux cents millions », « quatre-vingts milliards ».
			parts.push(`${belowThousand(count, true)} ${count > 1 ? scale.plural : scale.singular}`);
			rest -= count * scale.value;
		}
	}
	const thousands = Math.floor(rest / 1000);
	if (thousands > 0) {
		// « mille » invariable, jamais « un mille » ; ce qui le précède ne prend pas de s : « deux cent mille ».
		parts.push(thousands === 1 ? 'mille' : `${belowThousand(thousands, false)} mille`);
		rest -= thousands * 1000;
	}
	if (rest > 0) parts.push(belowThousand(rest, true));
	return parts.join(' ');
}

/**
 * Montant FCFA en toutes lettres : « soixante-quinze mille francs CFA », « un franc CFA », « zéro franc CFA ».
 * Un nombre qui finit par « million(s) » ou « milliard(s) »… prend « de » : « un million de francs CFA ».
 */
export function amountInFrenchWords(amount: Fcfa): string {
	const n = assertFcfa(amount);
	const words = numberInFrenchWords(n);
	if (n <= 1) return `${words} franc CFA`;
	const endsWithNoun = n >= 1_000_000 && n % 1_000_000 === 0;
	return `${words} ${endsWithNoun ? 'de ' : ''}francs CFA`;
}
