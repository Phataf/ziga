/**
 * Schémas du back-office (lot 04), partagés par l'API et les écrans. Montants en entiers FCFA (règle 2).
 */
import { z } from 'zod';
import { isIsoDate } from './dates.js';
import { FEATURE_KEYS, GLOBAL_MODES, PLAN_IDS, type FeatureKey } from './features.js';
import { idSchema } from './ids.js';
import { SUBSCRIPTION_PAYMENT_STATUSES } from './subscriptions.js';

const reason = (min: number, message: string) =>
	z.string().trim().min(min, { error: message }).max(500, { error: 'Motif trop long (500 caractères au plus).' });
const isoDate = z.string().refine(isIsoDate, { error: 'Date invalide.' });
const fcfa = z.number().int({ error: 'Montant en francs CFA entiers.' }).nonnegative({ error: 'Montant positif ou nul.' });
const quota = z.number().int().positive().nullable();
const featureKey = z.enum(FEATURE_KEYS as [FeatureKey, ...FeatureKey[]]);

/** Motif d'une action qui touche toutes les organisations ou une organisation précise. */
export const ADMIN_REASON_MIN = 5;
/** Motif d'un accès d'assistance : il doit expliquer la demande. */
export const SUPPORT_REASON_MIN = 15;
/** Durée maximale d'un accès d'assistance : 24 heures. */
export const SUPPORT_MAX_MINUTES = 24 * 60;
export const SUPPORT_DURATIONS = [30, 60, 120, 240, 480, 1440] as const;

export const setFeatureModeSchema = z.object({
	mode: z.enum(GLOBAL_MODES),
	reason: reason(ADMIN_REASON_MIN, 'Indiquez le motif (5 caractères au moins).')
});

export const createOverrideSchema = z.object({
	featureKey,
	scope: z.enum(['organization', 'user']),
	targetId: idSchema,
	value: z.boolean(),
	reason: reason(ADMIN_REASON_MIN, 'Indiquez le motif (5 caractères au moins).'),
	endsOn: isoDate.nullish().transform((v) => v ?? null)
});

export const setPlanFeatureSchema = z.object({
	planId: z.enum(PLAN_IDS),
	featureKey,
	included: z.boolean(),
	quota: z
		.number()
		.int()
		.positive()
		.nullish()
		.transform((v) => v ?? null)
});

export const updatePlanSchema = z.object({
	monthlyPrice: fcfa.nullable(),
	yearlyPrice: fcfa.nullable(),
	maxUnits: quota,
	maxUsers: quota,
	reason: reason(ADMIN_REASON_MIN, 'Indiquez le motif (5 caractères au moins).')
});

export const QUOTA_KEYS = ['users', 'units', 'owner_statements'] as const;
export type QuotaKey = (typeof QUOTA_KEYS)[number];
export const QUOTA_LABELS: Record<QuotaKey, string> = {
	users: 'Utilisateurs',
	units: 'Unités',
	owner_statements: 'Relevés par mois'
};

export const createQuotaOverrideSchema = z.object({
	organizationId: idSchema,
	quota: z.enum(QUOTA_KEYS),
	value: z.number().int().positive(),
	reason: reason(ADMIN_REASON_MIN, 'Indiquez le motif (5 caractères au moins).'),
	endsOn: isoDate.nullish().transform((v) => v ?? null)
});

export const changePlanSchema = z.object({
	planId: z.enum(PLAN_IDS),
	reason: reason(ADMIN_REASON_MIN, 'Indiquez le motif (5 caractères au moins).')
});

export const suspendSchema = z.object({ reason: reason(ADMIN_REASON_MIN, 'Indiquez le motif de la suspension.') });
export const verifySchema = z.object({ reason: z.string().trim().max(500).optional() });

export const createSubscriptionSchema = z
	.object({
		organizationId: idSchema,
		planId: z.enum(PLAN_IDS),
		startsOn: isoDate,
		endsOn: isoDate,
		amount: fcfa,
		paymentStatus: z.enum(SUBSCRIPTION_PAYMENT_STATUSES),
		paymentReference: z
			.string()
			.trim()
			.max(120)
			.nullish()
			.transform((v) => v || null),
		paidOn: isoDate.nullish().transform((v) => v ?? null)
	})
	.refine((s) => s.startsOn <= s.endsOn, { path: ['endsOn'], error: 'La fin doit suivre le début.' })
	.refine((s) => s.paymentStatus !== 'paid' || (!!s.paymentReference && !!s.paidOn), {
		path: ['paymentReference'],
		error: 'Un abonnement payé exige la référence et la date du paiement reçu.'
	});

export const recordPaymentSchema = z.object({
	paymentReference: z.string().trim().min(3, { error: 'Indiquez la référence du paiement reçu.' }).max(120),
	paidOn: isoDate
});

export const openSupportAccessSchema = z.object({
	organizationId: idSchema,
	reason: reason(SUPPORT_REASON_MIN, 'Le motif doit expliquer la demande (15 caractères au moins).'),
	durationMinutes: z.number().int().min(5).max(SUPPORT_MAX_MINUTES, { error: 'Durée de 24 heures au plus.' })
});

// ---------------------------------------------------------------- vues renvoyées par l'API

export interface AdminOrganizationRow {
	id: string;
	type: 'agency' | 'landlord';
	name: string;
	legalName: string;
	phone: string;
	commune: string;
	verificationStatus: 'pending' | 'verified' | 'suspended';
	suspendedReason: string | null;
	planId: string;
	members: number;
	createdAt: string;
	subscription: { stage: string; paidUntil: string | null; blockedFrom: string | null };
}

export interface AdminUserRow {
	id: string;
	name: string;
	phone: string;
	status: string;
	platformRole: string | null;
	createdAt: string;
}

export interface FeatureRow {
	key: string;
	label: string;
	globalMode: 'disabled' | 'restricted' | 'enabled';
	planBound: boolean;
	requires: string[];
	plans: string[];
	activeOverrides: number;
	updatedAt: string;
	updatedBy: string | null;
}

export interface OverrideRow {
	id: string;
	featureKey: string;
	scope: 'organization' | 'user';
	targetId: string;
	targetName: string;
	value: boolean;
	reason: string;
	startsAt: string;
	endsAt: string | null;
	createdBy: string | null;
	createdAt: string;
}

export interface PlanRow {
	id: string;
	label: string;
	monthlyPrice: number | null;
	yearlyPrice: number | null;
	maxUnits: number | null;
	maxUsers: number | null;
	features: { key: string; quota: number | null }[];
	updatedAt: string;
}

export interface SubscriptionRow {
	id: string;
	organizationId: string;
	organizationName: string;
	planId: string;
	startsOn: string;
	endsOn: string;
	amount: number;
	paymentStatus: 'pending' | 'paid' | 'waived';
	paymentReference: string | null;
	paidOn: string | null;
	recordedBy: string | null;
	createdAt: string;
}

export interface SupportAccessRow {
	id: string;
	organizationId: string;
	organizationName: string;
	agentId: string;
	agentName: string;
	reason: string;
	startsAt: string;
	endsAt: string;
	closedAt: string | null;
	active: boolean;
}
