/**
 * Numéros de téléphone neufs pour les tests de bout en bout, sans dépendance à Playwright (testé par Vitest :
 * phone-numbers.test.ts).
 *
 * - Valides par la règle de l'application elle-même (`toE164` de packages/shared), jamais par une copie : un tirage
 *   refusé par cette règle est écarté.
 * - Uniques dans une exécution : chaque processus de Playwright a sa plage (son numéro de processus, unique même après
 *   un redémarrage), parcourue dans l'ordre. L'ancien tirage, fondé sur l'heure, pouvait donner deux fois le même
 *   numéro à deux processus.
 * - Jamais un compte du jeu d'essai (`reserved`).
 */
import { toE164 } from '@ziga/shared/phone';

/** Premiers chiffres essayés, dans l'ordre : séries mobiles d'abord. La règle partagée décide. */
const SERIES = ['7', '6', '5', '0', '2'];
/** Les numéros du jeu d'essai sont en 7000…, 7001…, 7002…, 7003… : les tirages commencent au-delà. */
const FIRST = 50_000;
const PER_WORKER = 100_000;

export function phoneNumberGenerator(worker: number, reserved: ReadonlySet<string> = new Set()): () => string {
	if (!Number.isInteger(worker) || worker < 0) throw new RangeError(`Numéro de processus invalide : ${worker}`);
	const block = String(worker % 100).padStart(2, '0');
	const number = (series: string, n: number) => `${series}${block}${String(n).padStart(5, '0')}`;
	// La série : la première que la règle partagée accepte, décalée tous les 100 processus (plages distinctes).
	const shift = Math.floor(worker / 100);
	const series = SERIES.map((_, i) => SERIES[(i + shift) % SERIES.length]!).find((s) => toE164(number(s, FIRST)));
	if (!series) throw new RangeError('Aucune série de numéros acceptée par la règle de l’application.');
	let next = FIRST;
	return () => {
		// Un tirage refusé par la règle, ou réservé, est écarté : on passe au suivant de la plage.
		while (next < PER_WORKER) {
			const national = number(series, next++);
			if (toE164(national) && !reserved.has(national)) return national;
		}
		throw new RangeError(`Plus de numéro libre pour le processus ${worker}.`);
	};
}
