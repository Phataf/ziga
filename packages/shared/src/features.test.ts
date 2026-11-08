/**
 * Résolution des interrupteurs (docs/FEATURE-FLAGS.md §3 et §8) : un test par étape, isolée, puis les combinaisons.
 */
import { describe, expect, it } from 'vitest';
import {
	catalogData,
	FEATURE_CATALOG,
	FEATURE_KEYS,
	isEnabled,
	PLAN_IDS,
	resolveAll,
	resolveFeature,
	STEP_NUMBERS,
	type FeatureOverride,
	type FeatureState,
	type GlobalMode,
	type ResolutionData
} from './features.js';

const now = new Date('2026-11-09T10:00:00Z');
const ORG = 'org-a';
const USER = 'user-1';
const COLLEAGUE = 'user-2';

/** Données minimales : une clé libre `x` et une clé liée aux formules `p` (incluse en Pro). */
function data(mode: GlobalMode = 'enabled', overrides: Partial<FeatureOverride>[] = [], planMode: GlobalMode = 'enabled'): ResolutionData {
	return {
		features: {
			x: { key: 'x', globalMode: mode, planBound: false, requires: [] },
			p: { key: 'p', globalMode: planMode, planBound: true, requires: [] }
		},
		planFeatures: { discovery: [], essential: [], pro: ['p'], custom: ['p'] },
		overrides: overrides.map((o) => ({
			featureKey: 'x',
			scope: 'organization',
			targetId: ORG,
			value: true,
			reason: 'motif de test',
			startsAt: new Date('2026-01-01T00:00:00Z'),
			endsAt: null,
			...o
		}))
	};
}

const ctx = (extra: object = {}) => ({ userId: USER, organizationId: ORG, planId: 'discovery', now, ...extra });

describe('les 7 étapes, chacune isolée', () => {
	it('1. coupée pour tous → non', () => {
		expect(resolveFeature('x', ctx(), data('disabled'))).toMatchObject({
			enabled: false,
			step: 'global_disabled',
			reason: 'Non — coupée pour tous'
		});
	});

	it('2. exception pour la personne → sa valeur', () => {
		const r = resolveFeature('x', ctx(), data('enabled', [{ scope: 'user', targetId: USER, value: false }]));
		expect(r).toMatchObject({ enabled: false, step: 'user_override', reason: 'Non — exception pour cette personne' });
	});

	it('3. exception pour l’organisation → sa valeur', () => {
		const r = resolveFeature('x', ctx(), data('restricted', [{ value: true, endsAt: new Date('2027-03-31T00:00:00Z') }]));
		expect(r).toMatchObject({
			enabled: true,
			step: 'organization_override',
			reason: 'Oui — exception pour l’organisation jusqu’au 31/03/2027'
		});
	});

	it('4. ouverte sur liste, sans exception → non', () => {
		expect(resolveFeature('x', ctx(), data('restricted'))).toMatchObject({
			enabled: false,
			step: 'restricted',
			reason: 'Non — ouverte sur liste'
		});
	});

	it('5. liée aux formules, absente de la formule → non', () => {
		expect(resolveFeature('p', ctx(), data())).toMatchObject({ enabled: false, step: 'plan', reason: 'Non — formule Découverte' });
		expect(resolveFeature('p', ctx({ planId: 'pro' }), data())).toMatchObject({ enabled: true, step: 'default' });
	});

	it('6. désactivée par le directeur → non', () => {
		expect(resolveFeature('x', ctx({ disabledByOrganization: ['x'] }), data())).toMatchObject({
			enabled: false,
			step: 'organization_setting',
			reason: 'Non — désactivée par l’organisation'
		});
	});

	it('7. sinon → oui', () => {
		expect(resolveFeature('x', ctx(), data())).toMatchObject({ enabled: true, step: 'default', reason: 'Oui' });
	});

	it('numérote les étapes de 1 à 7', () => {
		expect(
			['global_disabled', 'user_override', 'organization_override', 'restricted', 'plan', 'organization_setting', 'default'].map(
				(s) => STEP_NUMBERS[s as keyof typeof STEP_NUMBERS]
			)
		).toEqual([1, 2, 3, 4, 5, 6, 7]);
	});
});

describe('combinaisons (§8)', () => {
	it('arrêt d’urgence + exception oui → non', () => {
		expect(isEnabled('x', ctx(), data('disabled', [{ value: true }, { scope: 'user', targetId: USER, value: true }]))).toBe(false);
	});

	it('restreinte + exception organisation oui → oui', () => {
		expect(isEnabled('x', ctx(), data('restricted', [{ value: true }]))).toBe(true);
	});

	it('ouverte + exception utilisateur non → non pour lui, oui pour ses collègues', () => {
		const d = data('enabled', [{ scope: 'user', targetId: USER, value: false }]);
		expect(isEnabled('x', ctx(), d)).toBe(false);
		expect(isEnabled('x', ctx({ userId: COLLEAGUE }), d)).toBe(true);
	});

	it('exception expirée ignorée ; exception pas encore commencée ou révoquée ignorée', () => {
		expect(resolveFeature('x', ctx(), data('restricted', [{ endsAt: new Date('2026-11-01T00:00:00Z') }])).step).toBe('restricted');
		expect(resolveFeature('x', ctx(), data('restricted', [{ startsAt: new Date('2026-12-01T00:00:00Z') }])).step).toBe('restricted');
		expect(resolveFeature('x', ctx(), data('restricted', [{ revokedAt: new Date('2026-11-02T00:00:00Z') }])).step).toBe('restricted');
	});

	it('formule sans la clé + exception organisation oui → oui (geste commercial)', () => {
		const d = data('enabled', [{ featureKey: 'p', value: true }]);
		expect(resolveFeature('p', ctx(), d)).toMatchObject({ enabled: true, step: 'organization_override' });
	});

	it('l’exception de la personne l’emporte sur celle de l’organisation', () => {
		const d = data('enabled', [{ value: true }, { scope: 'user', targetId: USER, value: false }]);
		expect(resolveFeature('x', ctx(), d).step).toBe('user_override');
	});

	it('une exception « oui » l’emporte sur le réglage du directeur ; sans elle, le réglage s’applique', () => {
		expect(isEnabled('x', ctx({ disabledByOrganization: ['x'] }), data('enabled', [{ value: true }]))).toBe(true);
		expect(isEnabled('x', ctx({ disabledByOrganization: ['x'] }), data('enabled'))).toBe(false);
	});

	it('un directeur ne peut pas activer une clé fermée par la plateforme (son réglage ne fait que désactiver)', () => {
		expect(isEnabled('x', ctx({ disabledByOrganization: [] }), data('restricted'))).toBe(false);
		expect(isEnabled('p', ctx({ disabledByOrganization: [] }), data())).toBe(false);
	});

	it('sans organisation (vitrine, espace personnel) : étapes 1, 2, 4 et 7 seulement', () => {
		const noOrg = { userId: USER, now };
		expect(resolveFeature('x', noOrg, data('enabled', [{ value: false }])).step).toBe('default');
		expect(resolveFeature('p', noOrg, data()).step).toBe('default');
		expect(resolveFeature('x', noOrg, data('restricted')).step).toBe('restricted');
		expect(resolveFeature('x', noOrg, data('enabled', [{ scope: 'user', targetId: USER, value: false }])).step).toBe('user_override');
		expect(resolveFeature('x', { now }, data('disabled')).step).toBe('global_disabled');
	});

	it('une clé inconnue est fermée', () => {
		expect(resolveFeature('inconnue', ctx(), data())).toMatchObject({ enabled: false, step: 'unknown_key' });
	});
});

describe('dépendances', () => {
	it('payments.direct ouverte mais payments.registry coupée → non', () => {
		const d = catalogData([
			{
				featureKey: 'payments.direct',
				scope: 'organization',
				targetId: ORG,
				value: true,
				reason: 'pilote',
				startsAt: new Date(0),
				endsAt: null
			}
		]);
		// Données de test modifiables (le type public est en lecture seule).
		const modes = d.features as Record<string, FeatureState>;
		modes['payments.direct'] = { ...modes['payments.direct']!, globalMode: 'enabled' };
		expect(isEnabled('payments.direct', ctx({ planId: 'pro' }), d)).toBe(true);
		modes['payments.registry'] = { ...modes['payments.registry']!, globalMode: 'disabled' };
		expect(resolveFeature('payments.direct', ctx({ planId: 'pro' }), d)).toMatchObject({
			enabled: false,
			step: 'dependency',
			requiredKey: 'payments.registry',
			reason: 'Non — exige payments.registry (Non — coupée pour tous)'
		});
	});
});

describe('catalogue (§4)', () => {
	const d = catalogData();
	const plan = (p: string) => ({ organizationId: ORG, userId: USER, planId: p, now });

	it('contient les 17 clés, avec description et mode par défaut', () => {
		expect(FEATURE_KEYS).toHaveLength(17);
		for (const f of FEATURE_CATALOG) {
			expect(f.label.length, f.key).toBeGreaterThan(5);
			for (const r of f.requires) expect(FEATURE_KEYS, `${f.key} exige ${r}`).toContain(r);
			// Une fonctionnalité qui n'est pas liée aux formules n'est rattachée à aucune.
			if (!f.planBound) expect(f.plans, f.key).toHaveLength(0);
		}
	});

	it('modes au lancement : coupées pour tous', () => {
		const disabled = FEATURE_CATALOG.filter((f) => f.defaultMode === 'disabled').map((f) => f.key);
		expect(disabled.sort()).toEqual(
			[
				'listings.facebook_publish',
				'listings.featured',
				'listings.private_sellers',
				'media.virtual_tour_360',
				'notifications.whatsapp_api',
				'payments.direct'
			].sort()
		);
	});

	it('formules : agents et exports en Essentiel et Pro ; relevés partout ; Sur mesure inclut tout', () => {
		expect(isEnabled('field_agents', plan('discovery'), d)).toBe(false);
		expect(isEnabled('field_agents', plan('essential'), d)).toBe(true);
		expect(isEnabled('exports.csv', plan('discovery'), d)).toBe(false);
		expect(isEnabled('exports.csv', plan('pro'), d)).toBe(true);
		expect(isEnabled('collections.owner_statements', plan('discovery'), d)).toBe(true);
		const planBound = FEATURE_CATALOG.filter((f) => f.planBound).map((f) => f.key);
		for (const key of planBound) expect(d.planFeatures.custom, key).toContain(key);
		for (const key of [
			'notifications.whatsapp_api',
			'media.virtual_tour_360',
			'listings.facebook_publish',
			'payments.direct',
			'listings.featured'
		]) {
			expect(d.planFeatures.pro, key).toContain(key);
			expect(d.planFeatures.essential, key).not.toContain(key);
		}
	});

	it('resolveAll donne l’état et la raison de chaque clé', () => {
		const all = resolveAll(plan('discovery'), d);
		expect(Object.keys(all)).toHaveLength(17);
		expect(all['exports.csv']).toMatchObject({ enabled: false, reason: 'Non — formule Découverte' });
		expect(all['payments.direct']).toMatchObject({ enabled: false, reason: 'Non — coupée pour tous' });
		expect(PLAN_IDS).toContain('custom');
	});
});
