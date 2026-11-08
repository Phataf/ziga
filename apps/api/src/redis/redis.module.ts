import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';

/** Connexion Redis de vérification (santé). BullMQ ouvre ses propres connexions. */
@Injectable()
export class RedisService implements OnApplicationShutdown {
	readonly client: Redis;

	constructor(@Inject(APP_CONFIG) config: AppConfig) {
		this.client = new Redis(config.REDIS_URL, {
			lazyConnect: true,
			maxRetriesPerRequest: 1,
			enableOfflineQueue: false,
			connectionName: 'ziga-health'
		});
		// Les erreurs de connexion sont rapportées par /health/ready, pas par un événement non écouté.
		this.client.on('error', () => undefined);
	}

	async ping(): Promise<void> {
		if (this.client.status === 'wait' || this.client.status === 'end') await this.client.connect();
		const reply = await this.client.ping();
		if (reply !== 'PONG') throw new Error(`Réponse inattendue de Redis : ${reply}`);
	}

	async onApplicationShutdown(): Promise<void> {
		this.client.disconnect();
	}
}

@Global()
@Module({ providers: [RedisService], exports: [RedisService] })
export class RedisModule {}

/** Options de connexion BullMQ tirées de REDIS_URL. */
export function bullConnection(url: string) {
	const u = new URL(url);
	return {
		host: u.hostname,
		port: Number(u.port || 6379),
		...(u.username ? { username: decodeURIComponent(u.username) } : {}),
		...(u.password ? { password: decodeURIComponent(u.password) } : {}),
		...(u.pathname.length > 1 ? { db: Number(u.pathname.slice(1)) } : {}),
		...(u.protocol === 'rediss:' ? { tls: {} } : {}),
		// Exigé par BullMQ pour les workers : une commande bloquante ne doit pas échouer après N essais.
		maxRetriesPerRequest: null
	};
}
