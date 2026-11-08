import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import type pg from 'pg';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';
import { createDatabase, createPool, withOrganization, withTransaction, type Database, type Tx } from './database.js';

export const PG_POOL = Symbol('PG_POOL');

/** Point d'entrée unique vers la base pour les modules : jamais de connexion ouverte ailleurs. */
@Injectable()
export class DatabaseService implements OnApplicationShutdown {
	readonly db: Database;

	constructor(
		@Inject(PG_POOL) readonly pool: pg.Pool,
		@Inject(APP_CONFIG) private readonly config: AppConfig
	) {
		this.db = createDatabase(pool);
	}

	private get options() {
		return { statementTimeoutMs: this.config.DATABASE_STATEMENT_TIMEOUT_MS };
	}

	withOrganization<T>(organizationId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
		return withOrganization(this.db, organizationId, this.options, fn);
	}

	withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
		return withTransaction(this.db, this.options, fn);
	}

	/** Vérification de santé : une requête simple, avec un délai court. */
	async ping(): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query('select 1');
		} finally {
			client.release();
		}
	}

	/** Arrêt propre : le pool est fermé après la fin des requêtes en cours. */
	async onApplicationShutdown(): Promise<void> {
		await this.pool.end();
	}
}

@Global()
@Module({
	providers: [
		{
			provide: PG_POOL,
			inject: [APP_CONFIG],
			useFactory: (config: AppConfig) =>
				createPool({
					url: config.DATABASE_URL,
					max: config.DATABASE_POOL_MAX,
					connectionTimeoutMs: config.DATABASE_CONNECTION_TIMEOUT_MS,
					applicationName: process.argv[1]?.endsWith('worker.js') ? 'ziga-worker' : 'ziga-api'
				})
		},
		DatabaseService
	],
	exports: [DatabaseService]
})
export class DatabaseModule {}
