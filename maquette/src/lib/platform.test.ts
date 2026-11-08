import { describe, expect, it } from 'vitest';
import { features, overrides, platformOrganizations, resolveFeature, supportAccessErrors, type Feature } from './platform';

const today = '2026-11-07';
const org = (id: string) => platformOrganizations.find((o) => o.id === id)!;
const feature = (key: string) => features.find((f) => f.key === key)!;

describe('interrupteurs (docs/FEATURE-FLAGS.md §3, résolution simplifiée)', () => {
	it('coupée pour tous : non, même avec une exception', () => {
		const f: Feature = { ...feature('listings.featured'), mode: 'disabled' };
		expect(resolveFeature(f, org('agency-horizon'), overrides, today)).toEqual({ enabled: false, reason: 'Non — coupée pour tous' });
	});
	it('ouverte sur liste : oui seulement pour l’organisation en exception', () => {
		expect(resolveFeature(feature('listings.featured'), org('agency-horizon'), overrides, today).reason).toBe('Oui — exception jusqu’au 31/12/2026');
		expect(resolveFeature(feature('listings.featured'), org('agency-demo'), overrides, today).enabled).toBe(false);
	});
	it('une exception expirée est ignorée', () => {
		expect(resolveFeature(feature('listings.featured'), org('agency-horizon'), overrides, '2027-01-01').enabled).toBe(false);
	});
	it('formule qui ne l’inclut pas : non, avec la raison', () => {
		expect(resolveFeature(feature('field_agents'), org('agency-horizon'), overrides, today).reason).toBe('Non — formule Découverte');
		expect(resolveFeature(feature('field_agents'), org('agency-demo'), overrides, today).enabled).toBe(true);
	});
});

describe('accès d’assistance', () => {
	it('exige une organisation, un motif explicite et une durée de 2 heures au plus', () => {
		expect(supportAccessErrors({ organizationId: '', reason: 'aide', minutes: 240 })).toHaveLength(3);
		expect(supportAccessErrors({ organizationId: 'agency-demo', reason: 'Relevé d’octobre introuvable', minutes: 30 })).toEqual([]);
	});
});
