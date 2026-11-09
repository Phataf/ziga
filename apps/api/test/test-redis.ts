/**
 * État Redis partagé par les fichiers de tests d'intégration. Les fichiers tournent l'un après l'autre sur la même
 * base Redis (n° 1) ; sans remise à zéro, les compteurs de débit d'un fichier (adresse IP par défaut des clients de
 * test, numéros, échecs de connexion) pèsent sur le suivant. Seules les clés `ziga:test:*`, qui servent à tout
 * le lancement (réservation des blocs de numéros), survivent à la remise à zéro.
 */
import { Redis } from 'ioredis';

/** Préfixe des clés propres aux tests, gardées d'un fichier à l'autre. */
export const TEST_KEY_PREFIX = 'ziga:test:';
/** Compteur des blocs de numéros de téléphone : un bloc par fichier, pour tout le lancement. */
export const PHONE_BLOCK_KEY = `${TEST_KEY_PREFIX}phone-block`;

/** Client vers la base Redis des tests ; refuse toute autre base (garde-fou, comme le nom de la base PostgreSQL). */
export function testRedis(url = process.env.REDIS_URL): Redis {
	if (!url) throw new Error('Tests d’intégration : REDIS_URL manquante.');
	if (new URL(url).pathname !== '/1') throw new Error(`Base Redis de test refusée (doit être la n° 1) : ${url}`);
	return new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
}

/** Efface toutes les clés de l'application (débits, délais, caches), sauf celles des tests. Renvoie le nombre effacé. */
export async function resetSharedRedisState(redis: Redis): Promise<number> {
	let cursor = '0';
	let removed = 0;
	do {
		const [next, keys] = await redis.scan(cursor, 'COUNT', 500);
		cursor = next;
		const doomed = keys.filter((k) => !k.startsWith(TEST_KEY_PREFIX));
		if (doomed.length) removed += await redis.unlink(...doomed);
	} while (cursor !== '0');
	return removed;
}

/** Réserve le bloc de numéros suivant (1, 2, 3…) : deux fichiers n'ont jamais le même. */
export async function reservePhoneBlock(redis: Redis): Promise<number> {
	return redis.incr(PHONE_BLOCK_KEY);
}
