/**
 * Quotas des formules (lot 04) : `check(organizationId, planId, quota, used)`. Le module qui possède les données
 * compte l'usage (membres, unités…) et appelle ce service avant une création ; une exception de quota posée par
 * le back-office (motif, échéance) remplace la limite de la formule.
 */
import { Injectable } from '@nestjs/common';
import { PLAN_LABELS, type PlanId } from '@ziga/shared/features';
import type { QuotaKey } from '@ziga/shared/admin';
import { AppError } from '../../common/app-error.js';
import { FeaturesService } from './features.service.js';

export interface QuotaCheck {
	allowed: boolean;
	limit: number | null;
	used: number;
	/** Limite venue d'une exception de quota plutôt que de la formule. */
	fromOverride: boolean;
}

const UNIT: Record<QuotaKey, [string, string]> = {
	users: ['utilisateur', 'utilisateurs'],
	units: ['unité', 'unités'],
	owner_statements: ['relevé par mois', 'relevés par mois']
};

@Injectable()
export class QuotasService {
	constructor(private readonly features: FeaturesService) {}

	async check(organizationId: string, planId: string, quota: QuotaKey, used: number, now = new Date()): Promise<QuotaCheck> {
		const snapshot = await this.features.snapshot();
		const override = snapshot.quotaOverrides.find(
			(q) => q.organizationId === organizationId && q.quota === quota && q.startsAt <= now && (!q.endsAt || q.endsAt > now)
		);
		const plan = snapshot.plans[planId];
		const fromPlan =
			quota === 'users'
				? plan?.maxUsers
				: quota === 'units'
					? plan?.maxUnits
					: snapshot.planQuotas[planId]?.['collections.owner_statements'];
		const limit = override ? override.value : (fromPlan ?? null);
		return { allowed: limit === null || used < limit, limit, used, fromOverride: !!override };
	}

	/** Refus clair (403 QUOTA_EXCEEDED) si la création dépasserait la limite. */
	async assert(organizationId: string, planId: string, quota: QuotaKey, used: number): Promise<void> {
		const r = await this.check(organizationId, planId, quota, used);
		if (r.allowed) return;
		const [one, many] = UNIT[quota];
		const label = PLAN_LABELS[planId as PlanId] ?? planId;
		throw new AppError(
			'QUOTA_EXCEEDED',
			`Votre formule ${label} permet ${r.limit} ${r.limit === 1 ? one : many}. Passez à une formule supérieure ou contactez Ziga.`,
			403,
			{ quota, limit: r.limit, used }
		);
	}
}
