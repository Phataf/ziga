/**
 * Exécuté avant chaque fichier de tests d'intégration (setupFiles), avant ses imports : le fichier part de compteurs
 * de débit vides, quel que soit le fichier qui l'a précédé. Les limites elles-mêmes ne changent pas.
 */
import { resetSharedRedisState, testRedis } from './test-redis.js';

const redis = testRedis();
try {
	await redis.connect();
	await resetSharedRedisState(redis);
} finally {
	redis.disconnect();
}
