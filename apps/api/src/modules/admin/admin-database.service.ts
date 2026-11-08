/**
 * Connexion du back-office (lot 04) : rôle `app_admin`, sans BYPASSRLS, pool distinct (DATABASE_ADMIN_URL).
 * Réservée au module admin, dont toutes les routes sont sous /admin : aucun autre module ne l'importe
 * (règle ESLint no-restricted-imports et test d'architecture). Les routes des organisations n'ont que `app_api`.
 *
 * Hors d'un contexte d'organisation, app_admin ne voit que l'annuaire (fonctions platform_*), les tables de la
 * plateforme (interrupteurs, formules, abonnements, accès d'assistance) et les événements de plateforme. Il n'entre
 * dans le contexte d'une organisation que pour une action du back-office sur elle, ou pendant un accès d'assistance,
 * toujours en lecture seule.
 */
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { AppError } from '../../common/app-error.js';
import { APP_CONFIG } from '../../config/config.module.js';
import type { AppConfig } from '../../config/env.js';
import { createDatabase, createPool, type Database, type Tx } from '../../db/database.js';
import { isUuid } from '@ziga/shared/ids';

@Injectable()
export class AdminDatabase implements OnApplicationShutdown {
	private readonly pool: pg.Pool | null;
	private readonly db: Database | null;

	constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
		this.pool = config.DATABASE_ADMIN_URL
			? createPool({
					url: config.DATABASE_ADMIN_URL,
					max: config.DATABASE_ADMIN_POOL_MAX,
					connectionTimeoutMs: config.DATABASE_CONNECTION_TIMEOUT_MS,
					applicationName: 'ziga-admin'
				})
			: null;
		this.db = this.pool ? createDatabase(this.pool) : null;
	}

	private get database(): Database {
		if (!this.db) throw new AppError('ADMIN_UNAVAILABLE', 'Back-office indisponible : DATABASE_ADMIN_URL n’est pas configurée.', 503);
		return this.db;
	}

	private async prepare(tx: Tx, organizationId: string | null): Promise<void> {
		await tx.execute(
			sql`select set_config('statement_timeout', ${String(this.config.DATABASE_STATEMENT_TIMEOUT_MS)}, true), set_config('app.organization_id', ${organizationId ?? ''}, true), set_config('app.user_id', '', true)`
		);
	}

	/** Transaction hors de toute organisation : annuaire, tables de la plateforme, événements de plateforme. */
	transaction<T>(fn: (tx: Tx) => Promise<T>, options: { readOnly?: boolean } = {}): Promise<T> {
		return this.database.transaction(
			async (tx) => {
				await this.prepare(tx, null);
				return fn(tx);
			},
			options.readOnly ? { accessMode: 'read only' } : undefined
		);
	}

	/**
	 * Transaction dans le contexte d'une organisation : action du back-office sur elle (journalisée chez elle),
	 * ou lecture d'un accès d'assistance (`readOnly`, toujours).
	 */
	withOrganization<T>(organizationId: string, fn: (tx: Tx) => Promise<T>, options: { readOnly?: boolean } = {}): Promise<T> {
		if (!isUuid(organizationId)) throw new AppError('NOT_FOUND', 'Organisation introuvable.', 404);
		return this.database.transaction(
			async (tx) => {
				await this.prepare(tx, organizationId);
				return fn(tx);
			},
			options.readOnly ? { accessMode: 'read only' } : undefined
		);
	}

	async onApplicationShutdown(): Promise<void> {
		await this.pool?.end();
	}
}
