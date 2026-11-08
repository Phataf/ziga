/**
 * Moteur des interrupteurs (lot 04, docs/FEATURE-FLAGS.md) : une seule fonction de résolution (packages/shared),
 * alimentée par une copie des tables mise en cache.
 *
 * Propagation (§6) : la copie vit dans Redis et dans la mémoire de chaque processus. Toute modification par le
 * back-office efface la copie Redis et publie `ziga:features:changed` : chaque processus vide sa mémoire aussitôt.
 * Si une publication se perd, la mémoire expire d'elle-même (FEATURES_CACHE_TTL_SECONDS, 15 s par défaut) :
 * un changement est visible partout en moins de 30 secondes. Sans Redis, lecture directe en base.
 */
import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { isFeatureKey, resolveAll, resolveFeature, type FeatureKey, type Resolution, type ResolutionContext } from '@ziga/shared/features';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { AppError } from '../../common/app-error.js';
import { RequestContext } from '../../common/request-context.js';
import { APP_CONFIG } from '../../config/config.module.js';
import type { AppConfig } from '../../config/env.js';
import { DatabaseService } from '../../db/database.module.js';
import type { Tx } from '../../db/database.js';
import { organizationFeatureSettings } from '../../db/schema/features.js';
import { loadSnapshot, reviveSnapshot, type FeatureSnapshot } from './features.repository.js';

export const FEATURES_CACHE_KEY = 'ziga:features:snapshot';
export const FEATURES_CHANNEL = 'ziga:features:changed';

export interface OrganizationFeatureContext {
	organizationId: string;
	planId: string;
	disabled: string[];
}

@Injectable()
export class FeaturesService implements OnModuleInit, OnApplicationShutdown {
	private local: FeatureSnapshot | null = null;
	private localAt = 0;
	private redis: Redis | null = null;
	private subscriber: Redis | null = null;

	constructor(
		private readonly database: DatabaseService,
		@Inject(APP_CONFIG) private readonly config: AppConfig,
		private readonly logger: PinoLogger
	) {
		logger.setContext(FeaturesService.name);
	}

	async onModuleInit(): Promise<void> {
		const options = { maxRetriesPerRequest: 1, connectionName: 'ziga-features', lazyConnect: true };
		this.redis = new Redis(this.config.REDIS_URL, options);
		this.subscriber = new Redis(this.config.REDIS_URL, { ...options, connectionName: 'ziga-features-sub' });
		for (const c of [this.redis, this.subscriber]) c.on('error', () => undefined);
		this.subscriber.on('message', () => this.forget());
		try {
			await this.subscriber.connect();
			await this.subscriber.subscribe(FEATURES_CHANNEL);
		} catch (error) {
			this.logger.warn({ err: error }, 'Abonnement aux changements d’interrupteurs impossible : expiration locale seulement');
		}
	}

	async onApplicationShutdown(): Promise<void> {
		this.redis?.disconnect();
		this.subscriber?.disconnect();
	}

	private forget(): void {
		this.local = null;
		this.localAt = 0;
	}

	/** Copie courante : mémoire (si récente), sinon Redis, sinon la base (et la copie Redis est refaite). */
	async snapshot(): Promise<FeatureSnapshot> {
		const ttlMs = this.config.FEATURES_CACHE_TTL_SECONDS * 1000;
		if (this.local && Date.now() - this.localAt < ttlMs) return this.local;
		let snapshot: FeatureSnapshot | null = null;
		try {
			if (this.redis?.status === 'wait') await this.redis.connect();
			const raw = await this.redis?.get(FEATURES_CACHE_KEY);
			if (raw) snapshot = reviveSnapshot(raw);
		} catch {
			snapshot = null;
		}
		if (!snapshot) {
			snapshot = await loadSnapshot(this.database.db);
			try {
				await this.redis?.set(FEATURES_CACHE_KEY, JSON.stringify(snapshot), 'EX', this.config.FEATURES_CACHE_TTL_SECONDS);
			} catch {
				// Redis indisponible : la base reste la source, sans cache partagé.
			}
		}
		this.local = snapshot;
		this.localAt = Date.now();
		return snapshot;
	}

	/** Après une modification : copie Redis effacée et changement publié à tous les processus. */
	async invalidate(): Promise<void> {
		this.forget();
		try {
			if (this.redis?.status === 'wait') await this.redis.connect();
			await this.redis?.del(FEATURES_CACHE_KEY);
			await this.redis?.publish(FEATURES_CHANNEL, String(Date.now()));
		} catch (error) {
			this.logger.warn({ err: error }, 'Publication du changement d’interrupteur impossible : expiration locale seulement');
		}
	}

	/**
	 * Désactivations faites par l'organisation, lues dans son contexte (transaction de la requête, ou courte
	 * transaction). La formule vient de l'appelant : le module organizations la donne (garde OrganizationContext).
	 */
	async organizationContext(organizationId: string, planId: string, tx?: Tx): Promise<OrganizationFeatureContext> {
		const read = async (t: Tx) => {
			const settings = await t
				.select({ key: organizationFeatureSettings.featureKey, disabled: organizationFeatureSettings.disabledByOrganization })
				.from(organizationFeatureSettings);
			return { organizationId, planId, disabled: settings.filter((s) => s.disabled).map((s) => s.key) };
		};
		const current = tx ?? RequestContext.get()?.tx;
		return current ? read(current) : this.database.withOrganization(organizationId, read);
	}

	/** Back-office (transaction app_admin) : désactivations d'une organisation, ou de toutes, par les fonctions platform_*. */
	async disabledFor(tx: Tx, organizationId: string): Promise<string[]> {
		const result = await tx.execute(sql`select platform_disabled_features as key from platform_disabled_features(${organizationId}::uuid)`);
		return (result.rows as { key: string }[]).map((r) => r.key);
	}

	async allDisabled(tx: Tx): Promise<Map<string, string[]>> {
		const result = await tx.execute(sql`select organization_id, feature_key from platform_all_disabled_features()`);
		const map = new Map<string, string[]>();
		for (const r of result.rows as { organization_id: string; feature_key: string }[]) {
			map.set(r.organization_id, [...(map.get(r.organization_id) ?? []), r.feature_key]);
		}
		return map;
	}

	context(userId: string | null, org: OrganizationFeatureContext | null, now = new Date()): ResolutionContext {
		return {
			userId,
			organizationId: org?.organizationId ?? null,
			planId: org?.planId ?? null,
			disabledByOrganization: org?.disabled ?? [],
			now
		};
	}

	async resolve(key: FeatureKey, userId: string | null, org: OrganizationFeatureContext | null): Promise<Resolution> {
		return resolveFeature(key, this.context(userId, org), await this.snapshot());
	}

	async resolveAll(userId: string | null, org: OrganizationFeatureContext | null): Promise<Record<string, Resolution>> {
		return resolveAll(this.context(userId, org), await this.snapshot());
	}

	/** Refus uniforme (403 FEATURE_DISABLED), avec le motif lisible. */
	async assertEnabled(key: FeatureKey, userId: string | null, org: OrganizationFeatureContext | null): Promise<void> {
		if (!isFeatureKey(key)) throw new AppError('FEATURE_DISABLED', 'Fonctionnalité inconnue.', 403, { key });
		const r = await this.resolve(key, userId, org);
		if (!r.enabled) {
			throw new AppError('FEATURE_DISABLED', `Cette fonctionnalité n’est pas disponible (${r.reason.replace(/^Non — /u, '')}).`, 403, {
				key,
				step: r.step,
				reason: r.reason
			});
		}
	}
}
