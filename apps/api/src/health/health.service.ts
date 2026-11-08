import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';
import { DatabaseService } from '../db/database.module.js';
import { RedisService } from '../redis/redis.module.js';
import { STORAGE, type StorageAdapter } from '../storage/storage.js';

export type CheckStatus = 'up' | 'down';

export interface CheckResult {
	status: CheckStatus;
	latencyMs: number;
	error?: string;
}

export interface Readiness {
	ready: boolean;
	shuttingDown: boolean;
	checks: { database: CheckResult; redis: CheckResult; storage: CheckResult };
}

/** Exécute une vérification avec un délai maximal ; ne lève jamais. */
export async function timed(check: () => Promise<void>, timeoutMs: number): Promise<CheckResult> {
	const start = performance.now();
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			check(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`délai dépassé (${timeoutMs} ms)`)), timeoutMs);
			})
		]);
		return { status: 'up', latencyMs: Math.round(performance.now() - start) };
	} catch (error) {
		return {
			status: 'down',
			latencyMs: Math.round(performance.now() - start),
			error: error instanceof Error ? error.message : String(error)
		};
	} finally {
		clearTimeout(timer);
	}
}

@Injectable()
export class HealthService {
	/** Passe à vrai dès le signal d'arrêt : le répartiteur de charge cesse d'envoyer du trafic. */
	shuttingDown = false;

	constructor(
		@Inject(APP_CONFIG) private readonly config: AppConfig,
		private readonly database: DatabaseService,
		private readonly redis: RedisService,
		@Inject(STORAGE) private readonly storage: StorageAdapter
	) {}

	async readiness(): Promise<Readiness> {
		const t = this.config.HEALTH_CHECK_TIMEOUT_MS;
		const [database, redis, storage] = await Promise.all([
			timed(() => this.database.ping(), t),
			timed(() => this.redis.ping(), t),
			timed(() => this.storage.check(), t)
		]);
		const checks = { database, redis, storage };
		const ready = !this.shuttingDown && Object.values(checks).every((c) => c.status === 'up');
		return { ready, shuttingDown: this.shuttingDown, checks };
	}
}
