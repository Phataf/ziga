/**
 * Modifications des interrupteurs, formules, quotas et abonnements (lot 04), par le back-office seulement.
 * Chaque méthode reçoit la transaction `app_admin` ouverte par le module admin (dans le contexte de l'organisation
 * concernée quand il y en a une) et écrit sa ligne d'audit dans cette même transaction, avec avant et après.
 * Après validation, l'appelant invalide le cache (`FeaturesService.invalidate`).
 */
import { Injectable } from '@nestjs/common';
import { addDays, toIsoDate } from '@ziga/shared/dates';
import { FEATURES_BY_KEY, isFeatureKey, type GlobalMode } from '@ziga/shared/features';
import { newId } from '@ziga/shared/ids';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { AppError } from '../../common/app-error.js';
import type { Tx } from '../../db/database.js';
import { featureOverrides, features, planFeatures, plans, quotaOverrides } from '../../db/schema/features.js';
import { subscriptions } from '../../db/schema/platform.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';

/** Fin d'une exception saisie en date : elle vaut jusqu'à la fin de ce jour (heure de Ouagadougou = UTC). */
export function endOfDay(isoDate: string | null): Date | null {
	return isoDate ? new Date(`${addDays(isoDate, 1)}T00:00:00Z`) : null;
}

@Injectable()
export class FeatureAdminService {
	constructor(private readonly audit: AuditService) {}

	private assertKey(key: string): void {
		if (!isFeatureKey(key)) throw new AppError('NOT_FOUND', 'Fonctionnalité inconnue.', 404);
	}

	// ------------------------------------------------------------ lecture (écrans du back-office)

	async listFeatures(tx: Tx) {
		const rows = await tx.select().from(features).orderBy(features.key);
		const counts = await tx
			.select({ key: featureOverrides.featureKey, n: sql<number>`count(*)::int` })
			.from(featureOverrides)
			.where(and(isNull(featureOverrides.revokedAt), sql`(${featureOverrides.endsAt} is null or ${featureOverrides.endsAt} > now())`))
			.groupBy(featureOverrides.featureKey);
		const included = await tx.select().from(planFeatures);
		return rows.map((f) => ({
			key: f.key,
			label: FEATURES_BY_KEY[f.key as keyof typeof FEATURES_BY_KEY]?.label ?? f.description,
			globalMode: f.globalMode,
			planBound: f.planBound,
			requires: f.requires,
			plans: included.filter((p) => p.featureKey === f.key).map((p) => p.planId),
			activeOverrides: counts.find((c) => c.key === f.key)?.n ?? 0,
			updatedAt: f.updatedAt.toISOString(),
			updatedBy: f.updatedBy
		}));
	}

	async overrides(tx: Tx, filter: { featureKey?: string; organizationId?: string; userId?: string } = {}) {
		const conditions = [isNull(featureOverrides.revokedAt)];
		if (filter.featureKey) conditions.push(eq(featureOverrides.featureKey, filter.featureKey));
		if (filter.organizationId) conditions.push(eq(featureOverrides.organizationId, filter.organizationId));
		if (filter.userId) conditions.push(eq(featureOverrides.userId, filter.userId));
		return tx
			.select()
			.from(featureOverrides)
			.where(and(...conditions))
			.orderBy(desc(featureOverrides.createdAt));
	}

	async plans(tx: Tx) {
		const rows = await tx.select().from(plans);
		const included = await tx.select().from(planFeatures);
		const order = ['discovery', 'essential', 'pro', 'custom'];
		return rows
			.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
			.map((p) => ({
				id: p.id,
				label: p.label,
				monthlyPrice: p.monthlyPrice,
				yearlyPrice: p.yearlyPrice,
				maxUnits: p.maxUnits,
				maxUsers: p.maxUsers,
				features: included.filter((i) => i.planId === p.id).map((i) => ({ key: i.featureKey, quota: i.quota })),
				updatedAt: p.updatedAt.toISOString()
			}));
	}

	async quotaOverrides(tx: Tx, organizationId?: string) {
		return tx
			.select()
			.from(quotaOverrides)
			.where(and(isNull(quotaOverrides.revokedAt), organizationId ? eq(quotaOverrides.organizationId, organizationId) : undefined))
			.orderBy(desc(quotaOverrides.createdAt));
	}

	async subscriptions(tx: Tx, organizationId?: string) {
		return tx
			.select()
			.from(subscriptions)
			.where(organizationId ? eq(subscriptions.organizationId, organizationId) : undefined)
			.orderBy(desc(subscriptions.endsOn), desc(subscriptions.createdAt));
	}

	// ------------------------------------------------------------ interrupteurs

	/** Mode global (couper pour tous, ouvrir sur liste, ouvrir à tous) : ligne de configuration de la plateforme. */
	async setMode(tx: Tx, actor: AuditActor, key: string, mode: GlobalMode, reason: string) {
		this.assertKey(key);
		const [before] = await tx.select().from(features).where(eq(features.key, key)).for('update');
		if (!before) throw new AppError('NOT_FOUND', 'Fonctionnalité inconnue.', 404);
		if (before.globalMode === mode) return;
		await tx
			.update(features)
			.set({ globalMode: mode, updatedAt: new Date(), updatedBy: actor.type === 'user' ? actor.userId : null })
			.where(eq(features.key, key));
		await this.audit.record(tx, {
			actor,
			action: 'feature.set_mode',
			objectType: 'feature',
			before: { key, mode: before.globalMode },
			after: { key, mode, reason },
			origin: 'admin'
		});
	}

	/**
	 * Exception pour une organisation ou une personne. Une exception active sur la même cible est révoquée (une seule
	 * à la fois). Pour une organisation, la transaction est dans son contexte : l'organisation la voit dans son journal.
	 */
	async addOverride(
		tx: Tx,
		actor: AuditActor,
		input: { featureKey: string; scope: 'organization' | 'user'; targetId: string; value: boolean; reason: string; endsOn: string | null }
	) {
		this.assertKey(input.featureKey);
		const target = input.scope === 'organization' ? featureOverrides.organizationId : featureOverrides.userId;
		const previous = await tx
			.update(featureOverrides)
			.set({ revokedAt: new Date(), revokedBy: actor.type === 'user' ? actor.userId : null })
			.where(
				and(
					eq(featureOverrides.featureKey, input.featureKey),
					eq(featureOverrides.scope, input.scope),
					eq(target, input.targetId),
					isNull(featureOverrides.revokedAt)
				)
			)
			.returning();
		const id = newId();
		const endsAt = endOfDay(input.endsOn);
		await tx.insert(featureOverrides).values({
			id,
			featureKey: input.featureKey,
			scope: input.scope,
			organizationId: input.scope === 'organization' ? input.targetId : null,
			userId: input.scope === 'user' ? input.targetId : null,
			value: input.value,
			reason: input.reason,
			endsAt,
			createdBy: actor.type === 'user' ? actor.userId : actor.type
		});
		const prev = previous[0];
		await this.audit.record(tx, {
			actor,
			organizationId: input.scope === 'organization' ? input.targetId : null,
			subjectUserId: input.scope === 'user' ? input.targetId : null,
			action: 'feature.override_set',
			objectType: 'feature_override',
			objectId: id,
			before: prev ? { key: prev.featureKey, value: prev.value, endsAt: prev.endsAt?.toISOString() ?? null } : null,
			after: { key: input.featureKey, value: input.value, reason: input.reason, endsAt: endsAt?.toISOString() ?? null },
			origin: 'admin'
		});
		return id;
	}

	/** Trouve une exception active (pour choisir le contexte de la transaction avant de la révoquer). */
	async findOverride(tx: Tx, id: string) {
		const [row] = await tx
			.select()
			.from(featureOverrides)
			.where(and(eq(featureOverrides.id, id), isNull(featureOverrides.revokedAt)))
			.limit(1);
		if (!row) throw new AppError('NOT_FOUND', 'Exception introuvable.', 404);
		return row;
	}

	async revokeOverride(tx: Tx, actor: AuditActor, id: string, reason: string) {
		const row = await this.findOverride(tx, id);
		await tx
			.update(featureOverrides)
			.set({ revokedAt: new Date(), revokedBy: actor.type === 'user' ? actor.userId : null })
			.where(eq(featureOverrides.id, id));
		await this.audit.record(tx, {
			actor,
			organizationId: row.organizationId,
			subjectUserId: row.userId,
			action: 'feature.override_revoke',
			objectType: 'feature_override',
			objectId: id,
			before: { key: row.featureKey, value: row.value },
			after: { revoked: true, reason },
			origin: 'admin'
		});
	}

	/** Inclure ou exclure une fonctionnalité d'une formule (et son quota). */
	async setPlanFeature(tx: Tx, actor: AuditActor, input: { planId: string; featureKey: string; included: boolean; quota: number | null }) {
		this.assertKey(input.featureKey);
		const [before] = await tx
			.select()
			.from(planFeatures)
			.where(and(eq(planFeatures.planId, input.planId), eq(planFeatures.featureKey, input.featureKey)));
		if (input.included) {
			await tx
				.insert(planFeatures)
				.values({ planId: input.planId, featureKey: input.featureKey, quota: input.quota })
				.onConflictDoUpdate({ target: [planFeatures.planId, planFeatures.featureKey], set: { quota: input.quota } });
		} else if (before) {
			await tx.delete(planFeatures).where(and(eq(planFeatures.planId, input.planId), eq(planFeatures.featureKey, input.featureKey)));
		}
		await this.audit.record(tx, {
			actor,
			action: 'plan.feature_set',
			objectType: 'plan',
			before: { plan: input.planId, key: input.featureKey, included: !!before, quota: before?.quota ?? null },
			after: { plan: input.planId, key: input.featureKey, included: input.included, quota: input.included ? input.quota : null },
			origin: 'admin'
		});
	}

	// ------------------------------------------------------------ formules et quotas

	/** Prix et quotas d'une formule : hypothèses du cadrage, modifiables par le rôle sales (journalisé). */
	async updatePlan(
		tx: Tx,
		actor: AuditActor,
		id: string,
		input: { monthlyPrice: number | null; yearlyPrice: number | null; maxUnits: number | null; maxUsers: number | null; reason: string }
	) {
		const [before] = await tx
			.select()
			.from(plans)
			.where(eq(plans.id, id as 'discovery'))
			.for('update');
		if (!before) throw new AppError('NOT_FOUND', 'Formule introuvable.', 404);
		const { reason, ...values } = input;
		await tx
			.update(plans)
			.set({ ...values, updatedAt: new Date(), updatedBy: actor.type === 'user' ? actor.userId : null })
			.where(eq(plans.id, before.id));
		await this.audit.record(tx, {
			actor,
			action: 'plan.update',
			objectType: 'plan',
			before: {
				plan: id,
				monthlyPrice: before.monthlyPrice,
				yearlyPrice: before.yearlyPrice,
				maxUnits: before.maxUnits,
				maxUsers: before.maxUsers
			},
			after: { plan: id, ...values, reason },
			origin: 'admin'
		});
	}

	async addQuotaOverride(
		tx: Tx,
		actor: AuditActor,
		input: { organizationId: string; quota: 'users' | 'units' | 'owner_statements'; value: number; reason: string; endsOn: string | null }
	) {
		const previous = await tx
			.update(quotaOverrides)
			.set({ revokedAt: new Date(), revokedBy: actor.type === 'user' ? actor.userId : null })
			.where(
				and(
					eq(quotaOverrides.organizationId, input.organizationId),
					eq(quotaOverrides.quota, input.quota),
					isNull(quotaOverrides.revokedAt)
				)
			)
			.returning();
		const id = newId();
		const endsAt = endOfDay(input.endsOn);
		await tx.insert(quotaOverrides).values({
			id,
			organizationId: input.organizationId,
			quota: input.quota,
			value: input.value,
			reason: input.reason,
			endsAt,
			createdBy: actor.type === 'user' ? actor.userId : actor.type
		});
		await this.audit.record(tx, {
			actor,
			organizationId: input.organizationId,
			action: 'quota.override_set',
			objectType: 'quota_override',
			objectId: id,
			before: previous[0] ? { quota: input.quota, value: previous[0].value } : null,
			after: { quota: input.quota, value: input.value, reason: input.reason, endsAt: endsAt?.toISOString() ?? null },
			origin: 'admin'
		});
		return id;
	}

	// ------------------------------------------------------------ abonnements (saisis à la main)

	async createSubscription(
		tx: Tx,
		actor: AuditActor,
		input: {
			organizationId: string;
			planId: string;
			startsOn: string;
			endsOn: string;
			amount: number;
			paymentStatus: 'pending' | 'paid' | 'waived';
			paymentReference: string | null;
			paidOn: string | null;
		}
	) {
		const id = newId();
		const by = actor.type === 'user' ? actor.userId : null;
		await tx
			.insert(subscriptions)
			.values({ id, ...input, planId: input.planId, recordedBy: by!, paymentRecordedBy: input.paymentStatus === 'paid' ? by : null });
		await this.audit.record(tx, {
			actor,
			organizationId: input.organizationId,
			action: 'subscription.create',
			objectType: 'subscription',
			objectId: id,
			after: {
				plan: input.planId,
				startsOn: input.startsOn,
				endsOn: input.endsOn,
				amount: input.amount,
				paymentStatus: input.paymentStatus
			},
			origin: 'admin'
		});
		return id;
	}

	/**
	 * Formule payante choisie sans abonnement en cours : un abonnement « à payer » d'un mois est créé, pour que le délai
	 * de grâce démarre (pas de blocage immédiat des créations).
	 */
	async ensurePendingSubscription(tx: Tx, actor: AuditActor, organizationId: string, planId: string) {
		const today = toIsoDate();
		const current = await tx
			.select({ id: subscriptions.id })
			.from(subscriptions)
			.where(and(eq(subscriptions.organizationId, organizationId), sql`${subscriptions.endsOn} >= ${today}`))
			.limit(1);
		if (current.length) return;
		const [plan] = await tx
			.select()
			.from(plans)
			.where(eq(plans.id, planId as 'discovery'));
		const end = new Date(`${today}T00:00:00Z`);
		end.setUTCMonth(end.getUTCMonth() + 1);
		await this.createSubscription(tx, actor, {
			organizationId,
			planId,
			startsOn: today,
			endsOn: addDays(end.toISOString().slice(0, 10), -1),
			amount: plan?.monthlyPrice ?? 0,
			paymentStatus: 'pending',
			paymentReference: null,
			paidOn: null
		});
	}

	async findSubscription(tx: Tx, id: string) {
		const [row] = await tx.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1);
		if (!row) throw new AppError('NOT_FOUND', 'Abonnement introuvable.', 404);
		return row;
	}

	/** Paiement reçu sur le compte de la plateforme (rôle finance) : référence et date obligatoires. */
	async recordPayment(tx: Tx, actor: AuditActor, id: string, input: { paymentReference: string; paidOn: string }) {
		const row = await this.findSubscription(tx, id);
		if (row.paymentStatus === 'paid') throw new AppError('ALREADY_PAID', 'Ce paiement est déjà enregistré.', 409);
		await tx
			.update(subscriptions)
			.set({ paymentStatus: 'paid', ...input, paymentRecordedBy: actor.type === 'user' ? actor.userId : null, updatedAt: new Date() })
			.where(eq(subscriptions.id, id));
		await this.audit.record(tx, {
			actor,
			organizationId: row.organizationId,
			action: 'subscription.payment_record',
			objectType: 'subscription',
			objectId: id,
			before: { paymentStatus: row.paymentStatus },
			after: { paymentStatus: 'paid', paymentReference: input.paymentReference, paidOn: input.paidOn, amount: row.amount },
			origin: 'admin'
		});
	}
}
