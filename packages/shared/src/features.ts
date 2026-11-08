/**
 * Interrupteurs de fonctionnalités (lot 04, docs/FEATURE-FLAGS.md, qui fait foi).
 * Catalogue des clés, formules et fonction de résolution unique, en TypeScript pur (sans base) : l'API l'appelle
 * avec les données lues par le module `features`, le simulateur du back-office aussi.
 * Ajouter une fonctionnalité = ajouter sa clé ici ET dans la spécification, puis une migration qui l'insère.
 */
import { formatDate } from './dates.js';

export const PLAN_IDS = ['discovery', 'essential', 'pro', 'custom'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface PlanDefinition {
	id: PlanId;
	label: string;
	/** Prix du cadrage (§7), hypothèses modifiables par le rôle `sales` (en FCFA, entiers). */
	monthlyPrice: number | null;
	yearlyPrice: number | null;
	/** Quotas ; `null` = sans limite (formule sur mesure). */
	maxUnits: number | null;
	maxUsers: number | null;
}

export const PLANS: readonly PlanDefinition[] = [
	{ id: 'discovery', label: 'Découverte', monthlyPrice: 0, yearlyPrice: 0, maxUnits: 10, maxUsers: 1 },
	{ id: 'essential', label: 'Essentiel', monthlyPrice: 15_000, yearlyPrice: 150_000, maxUnits: 60, maxUsers: 3 },
	{ id: 'pro', label: 'Pro', monthlyPrice: 35_000, yearlyPrice: 350_000, maxUnits: 250, maxUsers: 10 },
	// Sur mesure : toutes les fonctionnalités liées aux formules, sans quota, prix fixé à chaque abonnement.
	{ id: 'custom', label: 'Sur mesure', monthlyPrice: null, yearlyPrice: null, maxUnits: null, maxUsers: null }
];

export const PLAN_LABELS = Object.fromEntries(PLANS.map((p) => [p.id, p.label])) as Record<PlanId, string>;

export const GLOBAL_MODES = ['disabled', 'restricted', 'enabled'] as const;
export type GlobalMode = (typeof GLOBAL_MODES)[number];
export const GLOBAL_MODE_LABELS: Record<GlobalMode, string> = {
	disabled: 'Coupée pour tous',
	restricted: 'Ouverte sur liste',
	enabled: 'Ouverte à tous'
};

export interface FeatureDefinition {
	key: string;
	label: string;
	planBound: boolean;
	/** Clés requises : si l'une est désactivée, celle-ci l'est aussi. */
	requires: readonly string[];
	defaultMode: GlobalMode;
	/** Formules qui l'incluent au lancement (fonctionnalités liées aux formules seulement). */
	plans: readonly PlanId[];
	/** Quota par formule (ex. 2 relevés par mois en Découverte). */
	quotas?: Partial<Record<PlanId, number>>;
}

const ALL_PLANS: readonly PlanId[] = PLAN_IDS;
const PRO: readonly PlanId[] = ['pro', 'custom'];

/** Catalogue initial (§4 de la spécification ; réponses du porteur du 08/11/2026 pour les formules). */
export const FEATURE_CATALOG = [
	{
		key: 'payments.registry',
		label: 'Saisie des encaissements et reçus',
		planBound: false,
		requires: [],
		defaultMode: 'enabled',
		plans: []
	},
	{
		key: 'payments.direct',
		label: 'Paiement Mobile Money initié depuis la plateforme vers le compte de l’agence (lot 14)',
		planBound: true,
		requires: ['payments.registry'],
		defaultMode: 'disabled',
		// Pro ; en option pour une organisation Essentiel, par exception posée par organisation.
		plans: PRO
	},
	{
		key: 'listings.publication',
		label: 'Publier des annonces sur la vitrine',
		planBound: false,
		requires: [],
		defaultMode: 'enabled',
		plans: []
	},
	{
		key: 'listings.featured',
		label: 'Mise en avant d’annonces',
		planBound: true,
		requires: ['listings.publication'],
		defaultMode: 'disabled',
		plans: PRO
	},
	{
		key: 'listings.public_showcase',
		label: 'Vitrine publique accessible (arrêt d’urgence de toute la vitrine)',
		planBound: false,
		requires: [],
		defaultMode: 'enabled',
		plans: []
	},
	{
		key: 'leads.contact_form',
		label: 'Formulaire de contact sur les annonces',
		planBound: false,
		requires: [],
		defaultMode: 'enabled',
		plans: []
	},
	{
		key: 'collections.reminders_whatsapp_link',
		label: 'Relances par lien WhatsApp pré-rempli',
		planBound: false,
		requires: [],
		defaultMode: 'enabled',
		plans: []
	},
	{
		key: 'collections.owner_statements',
		label: 'Relevés propriétaires',
		planBound: true,
		requires: [],
		defaultMode: 'enabled',
		plans: ALL_PLANS,
		quotas: { discovery: 2 }
	},
	{
		key: 'field_agents',
		label: 'Rôle agent de terrain et validation des espèces',
		planBound: true,
		requires: [],
		defaultMode: 'enabled',
		plans: ['essential', 'pro', 'custom']
	},
	{ key: 'imports.excel', label: 'Import Excel', planBound: false, requires: [], defaultMode: 'enabled', plans: [] },
	{
		key: 'exports.csv',
		label: 'Exports CSV',
		planBound: true,
		requires: [],
		defaultMode: 'enabled',
		plans: ['essential', 'pro', 'custom']
	},
	{
		key: 'notifications.whatsapp_api',
		label: 'Messages par l’API WhatsApp Business (phase 4)',
		planBound: true,
		requires: [],
		defaultMode: 'disabled',
		plans: PRO
	},
	{
		key: 'listings.private_sellers',
		label: 'Publication par les particuliers (phase 4)',
		planBound: false,
		requires: [],
		defaultMode: 'disabled',
		plans: []
	},
	{ key: 'media.virtual_tour_360', label: 'Visites 360° (phase 4)', planBound: true, requires: [], defaultMode: 'disabled', plans: PRO },
	{
		key: 'portals.owner_space',
		label: 'Espace propriétaire regroupant toutes les organisations (D13, lot 10 ter)',
		planBound: false,
		requires: [],
		defaultMode: 'enabled',
		plans: []
	},
	{
		key: 'portals.tenant_space',
		label: 'Espace locataire regroupant tout son historique (D13, lot 10 ter)',
		planBound: false,
		requires: [],
		defaultMode: 'enabled',
		plans: []
	},
	{
		key: 'listings.facebook_publish',
		label: 'Publication automatique des annonces sur une page Facebook',
		planBound: true,
		requires: ['listings.publication'],
		defaultMode: 'disabled',
		plans: PRO
	}
] as const satisfies readonly FeatureDefinition[];

export type FeatureKey = (typeof FEATURE_CATALOG)[number]['key'];
export const FEATURE_KEYS = FEATURE_CATALOG.map((f) => f.key) as FeatureKey[];
export const FEATURES_BY_KEY = Object.fromEntries(FEATURE_CATALOG.map((f) => [f.key, f])) as unknown as Record<
	FeatureKey,
	FeatureDefinition
>;

export function isFeatureKey(value: unknown): value is FeatureKey {
	return typeof value === 'string' && value in FEATURES_BY_KEY;
}

// ---------------------------------------------------------------- résolution

export interface FeatureState {
	key: string;
	globalMode: GlobalMode;
	planBound: boolean;
	requires: readonly string[];
}

export type OverrideScope = 'organization' | 'user';

export interface FeatureOverride {
	featureKey: string;
	scope: OverrideScope;
	targetId: string;
	value: boolean;
	reason: string;
	startsAt: Date;
	endsAt: Date | null;
	revokedAt?: Date | null;
}

/** Données lues par le module `features` (ou fixées par un test) : jamais lues ailleurs. */
export interface ResolutionData {
	features: Readonly<Record<string, FeatureState>>;
	/** Clés incluses dans chaque formule (fonctionnalités liées aux formules). */
	planFeatures: Readonly<Record<string, readonly string[]>>;
	overrides: readonly FeatureOverride[];
}

export interface ResolutionContext {
	userId?: string | null;
	/** Absente : vitrine ou espace personnel (étapes 1, 2, 4 et 7 seulement). */
	organizationId?: string | null;
	planId?: string | null;
	/** Clés désactivées par le directeur pour son organisation. */
	disabledByOrganization?: Iterable<string>;
	now: Date;
}

export type ResolutionStep =
	| 'global_disabled'
	| 'user_override'
	| 'organization_override'
	| 'restricted'
	| 'plan'
	| 'organization_setting'
	| 'default'
	| 'dependency'
	| 'unknown_key';

/** Numéro de l'étape du §3 (1 à 7) ; les dépendances et les clés inconnues n'en ont pas. */
export const STEP_NUMBERS: Record<ResolutionStep, number | null> = {
	global_disabled: 1,
	user_override: 2,
	organization_override: 3,
	restricted: 4,
	plan: 5,
	organization_setting: 6,
	default: 7,
	dependency: null,
	unknown_key: null
};

export interface Resolution {
	key: string;
	enabled: boolean;
	step: ResolutionStep;
	/** Motif lisible : « Non — formule Découverte », « Oui — exception jusqu’au 31/03/2027 »… */
	reason: string;
	/** Exception qui a décidé, clé requise qui a bloqué. */
	override?: { scope: OverrideScope; reason: string; endsAt: Date | null };
	requiredKey?: string;
}

/** Une exception est active si elle n'est pas révoquée, a commencé et n'est pas échue (`ends_at` passé = ignorée). */
export function isOverrideActive(o: FeatureOverride, now: Date): boolean {
	return !o.revokedAt && o.startsAt.getTime() <= now.getTime() && (!o.endsAt || o.endsAt.getTime() > now.getTime());
}

function findOverride(data: ResolutionData, key: string, scope: OverrideScope, targetId: string | null | undefined, now: Date) {
	if (!targetId) return undefined;
	return data.overrides.find((o) => o.featureKey === key && o.scope === scope && o.targetId === targetId && isOverrideActive(o, now));
}

function overrideReason(o: FeatureOverride, who: string): string {
	return `${o.value ? 'Oui' : 'Non'} — exception ${who}${o.endsAt ? ` jusqu’au ${formatDate(o.endsAt)}` : ''}`;
}

function resolveOwn(key: string, ctx: ResolutionContext, data: ResolutionData): Resolution {
	const feature = data.features[key];
	if (!feature) return { key, enabled: false, step: 'unknown_key', reason: 'Non — fonctionnalité inconnue' };
	const now = ctx.now;
	const hasOrganization = !!ctx.organizationId;

	// 1. Arrêt d'urgence : aucune exception ne s'applique.
	if (feature.globalMode === 'disabled') return { key, enabled: false, step: 'global_disabled', reason: 'Non — coupée pour tous' };

	// 2. Exception pour la personne.
	const user = findOverride(data, key, 'user', ctx.userId, now);
	if (user) {
		return {
			key,
			enabled: user.value,
			step: 'user_override',
			reason: overrideReason(user, 'pour cette personne'),
			override: { scope: 'user', reason: user.reason, endsAt: user.endsAt }
		};
	}

	// 3. Exception pour l'organisation.
	if (hasOrganization) {
		const org = findOverride(data, key, 'organization', ctx.organizationId, now);
		if (org) {
			return {
				key,
				enabled: org.value,
				step: 'organization_override',
				reason: overrideReason(org, 'pour l’organisation'),
				override: { scope: 'organization', reason: org.reason, endsAt: org.endsAt }
			};
		}
	}

	// 4. Ouverte sur liste : seulement par exception.
	if (feature.globalMode === 'restricted') return { key, enabled: false, step: 'restricted', reason: 'Non — ouverte sur liste' };

	if (hasOrganization) {
		// 5. Formule de l'organisation.
		if (feature.planBound) {
			const plan = ctx.planId ?? 'discovery';
			if (!(data.planFeatures[plan] ?? []).includes(key)) {
				const label = PLAN_LABELS[plan as PlanId] ?? plan;
				return { key, enabled: false, step: 'plan', reason: `Non — formule ${label}` };
			}
		}
		// 6. Désactivée par le directeur pour son organisation.
		if (ctx.disabledByOrganization && new Set(ctx.disabledByOrganization).has(key)) {
			return { key, enabled: false, step: 'organization_setting', reason: 'Non — désactivée par l’organisation' };
		}
	}

	// 7. Ouverte.
	return { key, enabled: true, step: 'default', reason: 'Oui' };
}

/**
 * `isEnabled` et `explain` de la spécification : les 7 étapes du §3, dans l'ordre exact, puis les dépendances
 * (une clé requise désactivée désactive la clé qui en dépend). La permission du rôle se vérifie à part :
 * accès réel = resolveFeature(...).enabled && can(rôle, action).
 */
export function resolveFeature(
	key: string,
	ctx: ResolutionContext,
	data: ResolutionData,
	seen: ReadonlySet<string> = new Set()
): Resolution {
	const own = resolveOwn(key, ctx, data);
	if (!own.enabled) return own;
	const next = new Set(seen).add(key);
	for (const required of data.features[key]?.requires ?? []) {
		if (next.has(required)) continue;
		const dep = resolveFeature(required, ctx, data, next);
		if (!dep.enabled) {
			return { key, enabled: false, step: 'dependency', reason: `Non — exige ${required} (${dep.reason})`, requiredKey: required };
		}
	}
	return own;
}

export function isEnabled(key: string, ctx: ResolutionContext, data: ResolutionData): boolean {
	return resolveFeature(key, ctx, data).enabled;
}

/** État effectif de toutes les clés du catalogue (simulateur, onglets « Fonctionnalités », GET /me/features). */
export function resolveAll(ctx: ResolutionContext, data: ResolutionData): Record<string, Resolution> {
	return Object.fromEntries(Object.keys(data.features).map((key) => [key, resolveFeature(key, ctx, data)]));
}

/** Données initiales, d'après le catalogue (tests, et contenu de la migration). */
export function catalogData(overrides: FeatureOverride[] = []): ResolutionData {
	const features: Record<string, FeatureState> = {};
	const planFeatures: Record<string, string[]> = Object.fromEntries(PLAN_IDS.map((p) => [p, []]));
	for (const f of FEATURE_CATALOG as readonly FeatureDefinition[]) {
		features[f.key] = { key: f.key, globalMode: f.defaultMode, planBound: f.planBound, requires: f.requires };
		for (const p of f.plans) planFeatures[p]!.push(f.key);
	}
	return { features, planFeatures, overrides };
}

/** Vue d'une résolution renvoyée par l'API (dates en ISO). */
export interface FeatureStatusView {
	enabled: boolean;
	step: ResolutionStep;
	stepNumber: number | null;
	reason: string;
}

export function toStatusView(r: Resolution): FeatureStatusView {
	return { enabled: r.enabled, step: r.step, stepNumber: STEP_NUMBERS[r.step], reason: r.reason };
}
