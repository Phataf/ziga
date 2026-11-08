/**
 * Limites de débit et délais progressifs, dans Redis (l'API reste sans état et peut être multipliée).
 * - Débit : fenêtre fixe par clé (numéro de téléphone d'abord ; adresse IP avec un plafond large).
 * - Échecs de connexion : délai qui double à chaque échec (1 s, 2 s, 4 s…, plafonné à 60 s), compté par numéro
 *   et par adresse IP ; l'adresse IP a une marge d'échecs avant son premier délai, car beaucoup d'abonnés la partagent.
 */
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module.js';
import type { AppConfig } from '../../config/env.js';
import { RedisService } from '../../redis/redis.module.js';

const HIT = `local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {c, redis.call('PTTL', KEYS[1])}`;

const FAIL = `local c = redis.call('HINCRBY', KEYS[1], 'count', 1)
local allowance = tonumber(ARGV[1])
local delay = 0
if c > allowance then
	delay = math.min(tonumber(ARGV[2]) * 2 ^ (c - allowance - 1), tonumber(ARGV[3]))
	redis.call('HSET', KEYS[1], 'until', tonumber(ARGV[4]) + delay)
end
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return {c, delay}`;

export interface HitResult {
	allowed: boolean;
	retryAfterSeconds: number;
}

@Injectable()
export class ThrottleService {
	constructor(
		private readonly redis: RedisService,
		@Inject(APP_CONFIG) private readonly config: AppConfig
	) {}

	private async client() {
		const c = this.redis.client;
		if (c.status === 'wait' || c.status === 'end') await c.connect();
		return c;
	}

	/** Compte une demande ; refusée au-delà de `limit` dans la fenêtre. */
	async hit(key: string, limit: number, windowMs: number): Promise<HitResult> {
		const [count, ttl] = (await (await this.client()).eval(HIT, 1, key, windowMs)) as [number, number];
		return { allowed: count <= limit, retryAfterSeconds: Math.max(1, Math.ceil(ttl / 1000)) };
	}

	/** Secondes à attendre avant un nouvel essai (0 : essai permis). */
	async waitFor(key: string, now = Date.now()): Promise<number> {
		const until = Number(await (await this.client()).hget(key, 'until'));
		return until > now ? Math.ceil((until - now) / 1000) : 0;
	}

	/** Note un échec et allonge le délai suivant ; renvoie ce délai en millisecondes. */
	async recordFailure(key: string, allowance: number, windowMs: number, now = Date.now()): Promise<number> {
		const c = this.config;
		const [, delay] = (await (
			await this.client()
		).eval(FAIL, 1, key, allowance, c.AUTH_FAILURE_BASE_DELAY_MS, c.AUTH_FAILURE_MAX_DELAY_MS, now, windowMs)) as [number, number];
		return delay;
	}

	async clear(key: string): Promise<void> {
		await (await this.client()).del(key);
	}
}
