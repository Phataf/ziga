/**
 * Lecture des tables d'interrupteurs et de formules (lot 04). Seul le module `features` importe leur schéma
 * (règle ESLint `no-restricted-imports` et test d'architecture) : personne ne les lit ailleurs.
 */
import type { FeatureOverride, ResolutionData } from '@ziga/shared/features';
import { and, isNull } from 'drizzle-orm';
import type { Database, Tx } from '../../db/database.js';
import { featureOverrides, features, planFeatures, plans, quotaOverrides } from '../../db/schema/features.js';

export interface PlanLimits {
	id: string;
	label: string;
	monthlyPrice: number | null;
	yearlyPrice: number | null;
	maxUnits: number | null;
	maxUsers: number | null;
	updatedAt: Date;
}

export interface QuotaOverrideRow {
	organizationId: string;
	quota: 'users' | 'units' | 'owner_statements';
	value: number;
	startsAt: Date;
	endsAt: Date | null;
}

/** Tout ce que la résolution et les quotas lisent : petit, mis en cache entier. */
export interface FeatureSnapshot extends ResolutionData {
	plans: Record<string, PlanLimits>;
	/** Quotas par formule et clé (ex. relevés par mois). */
	planQuotas: Record<string, Record<string, number>>;
	quotaOverrides: QuotaOverrideRow[];
	featureMeta: Record<string, { description: string; updatedAt: Date; updatedBy: string | null }>;
	loadedAt: Date;
}

export async function loadSnapshot(db: Database | Tx): Promise<FeatureSnapshot> {
	const [featureRows, planRows, planFeatureRows, overrideRows, quotaRows] = await Promise.all([
		db.select().from(features),
		db.select().from(plans),
		db.select().from(planFeatures),
		db.select().from(featureOverrides).where(isNull(featureOverrides.revokedAt)),
		db
			.select()
			.from(quotaOverrides)
			.where(and(isNull(quotaOverrides.revokedAt)))
	]);
	const featureStates: Record<string, FeatureSnapshot['features'][string]> = {};
	const included: Record<string, string[]> = {};
	const snapshot: FeatureSnapshot = {
		features: featureStates,
		planFeatures: included,
		overrides: [],
		plans: {},
		planQuotas: {},
		quotaOverrides: [],
		featureMeta: {},
		loadedAt: new Date()
	};
	for (const f of featureRows) {
		featureStates[f.key] = { key: f.key, globalMode: f.globalMode, planBound: f.planBound, requires: f.requires };
		snapshot.featureMeta[f.key] = { description: f.description, updatedAt: f.updatedAt, updatedBy: f.updatedBy };
	}
	for (const p of planRows) {
		snapshot.plans[p.id] = p;
		included[p.id] = [];
		snapshot.planQuotas[p.id] = {};
	}
	for (const pf of planFeatureRows) {
		included[pf.planId]?.push(pf.featureKey);
		if (pf.quota !== null) snapshot.planQuotas[pf.planId]![pf.featureKey] = pf.quota;
	}
	snapshot.overrides = overrideRows.map((o): FeatureOverride => ({
		featureKey: o.featureKey,
		scope: o.scope,
		targetId: (o.scope === 'organization' ? o.organizationId : o.userId)!,
		value: o.value,
		reason: o.reason,
		startsAt: o.startsAt,
		endsAt: o.endsAt,
		revokedAt: o.revokedAt
	}));
	snapshot.quotaOverrides = quotaRows.map((q) => ({
		organizationId: q.organizationId,
		quota: q.quota,
		value: q.value,
		startsAt: q.startsAt,
		endsAt: q.endsAt
	}));
	return snapshot;
}

/** Copie du cache (Redis) → objets : les dates y sont des chaînes. */
export function reviveSnapshot(raw: string): FeatureSnapshot {
	const s = JSON.parse(raw) as FeatureSnapshot;
	const d = (v: unknown) => (v ? new Date(v as string) : null);
	s.loadedAt = new Date(s.loadedAt);
	s.overrides = s.overrides.map((o) => ({ ...o, startsAt: d(o.startsAt)!, endsAt: d(o.endsAt), revokedAt: d(o.revokedAt) }));
	s.quotaOverrides = s.quotaOverrides.map((q) => ({ ...q, startsAt: d(q.startsAt)!, endsAt: d(q.endsAt) }));
	for (const p of Object.values(s.plans)) p.updatedAt = new Date(p.updatedAt);
	for (const m of Object.values(s.featureMeta)) m.updatedAt = new Date(m.updatedAt);
	return s;
}
