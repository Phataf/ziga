/**
 * Accès PostgreSQL : un pool `pg` par processus, connecté avec le rôle `app_api` (sans BYPASSRLS).
 *
 * Tout passe par une transaction qui fixe ses réglages avec `set_config(…, true)`, l'équivalent paramétré de
 * `SET LOCAL` : rien ne reste attaché à la connexion une fois la transaction finie. C'est ce qui rend l'API
 * compatible avec PgBouncer en mode transaction (lot 13), et sans état : le pool peut être partagé ou multiplié.
 */
import { isUuid } from '@ziga/shared/ids';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { AppError } from '../common/app-error.js';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;
/** Transaction Drizzle passée aux fonctions de `withOrganization`. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface PoolOptions {
	url: string;
	max: number;
	connectionTimeoutMs: number;
	applicationName: string;
}

export function createPool(options: PoolOptions): pg.Pool {
	return new pg.Pool({
		connectionString: options.url,
		max: options.max,
		connectionTimeoutMillis: options.connectionTimeoutMs,
		idleTimeoutMillis: 30_000,
		application_name: options.applicationName,
		// Pas de `options: -c statement_timeout=…` : PgBouncer en mode transaction ne les transmet pas.
		allowExitOnIdle: false
	});
}

export function createDatabase(pool: pg.Pool): Database {
	return drizzle(pool, { schema });
}

export interface TransactionOptions {
	/** Délai maximal de chaque requête de la transaction (`SET LOCAL statement_timeout`). */
	statementTimeoutMs: number;
}

/** Transaction technique, sans organisation : santé, migrations de données, tâches de la plateforme. */
export async function withTransaction<T>(db: Database, options: TransactionOptions, fn: (tx: Tx) => Promise<T>): Promise<T> {
	return db.transaction(async (tx) => {
		await tx.execute(sql`select set_config('statement_timeout', ${String(options.statementTimeoutMs)}, true)`);
		return fn(tx);
	});
}

/**
 * Ouvre une transaction dans le contexte d'une organisation : `SET LOCAL app.organization_id`.
 * Les politiques RLS lisent ce réglage par `current_organization_id()`. Toute requête métier passe par ici.
 */
export async function withOrganization<T>(
	db: Database,
	organizationId: string,
	options: TransactionOptions,
	fn: (tx: Tx) => Promise<T>
): Promise<T> {
	if (!isUuid(organizationId)) {
		throw new AppError('INVALID_ORGANIZATION', 'Organisation invalide.', 400);
	}
	return withTransaction(db, options, async (tx) => {
		await tx.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`);
		return fn(tx);
	});
}
