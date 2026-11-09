import { resolveAll } from '@ziga/shared/features';
import { describe, expect, it } from 'vitest';
import { disabledKeys, jsonArray, toMember, toOrganizationView, toResolutionData } from './views';

const orgRow = {
	id: 'org-1',
	type: 'agency',
	legal_name: 'Faso Immobilier SARL',
	trade_name: 'Faso Immobilier',
	phone: '+22625300000',
	address: null,
	commune: 'Ouagadougou',
	po_box: '',
	rccm: 'BF-OUA-2024-B-1',
	ifu: null,
	verification_status: 'verified',
	plan_id: 'pro',
	accepted_payment_methods: '["cash","bank_transfer"]',
	logo_id: 'logo-9',
	updated_at: '2026-11-09T10:00:00Z',
	rep_name: 'Awa Ouédraogo',
	rep_id_type: 'cnib',
	rep_id_issued_on: '2020-01-02'
};

describe('vues locales (lot 05)', () => {
	it('fiche de l’organisation : champs vides en null, moyens de paiement, logo en place', () => {
		const v = toOrganizationView(orgRow, 'https://api.example.test/');
		expect(v).toMatchObject({
			id: 'org-1',
			tradeName: 'Faso Immobilier',
			address: null,
			poBox: null,
			planId: 'pro',
			acceptedPaymentMethods: ['cash', 'bank_transfer'],
			logo: { id: 'logo-9', status: 'ready', webUrl: 'https://api.example.test/logos/org-1/logo-9/web.webp' }
		});
		expect(v.representative).toMatchObject({ name: 'Awa Ouédraogo', idType: 'cnib', idIssuedOn: '2020-01-02', idNumber: null });
	});

	it('sans représentant synchronisé (autre rôle que directeur) : représentant vide, rien d’inventé', () => {
		const { rep_name: _n, rep_id_type: _t, rep_id_issued_on: _d, ...withoutRep } = orgRow;
		expect(Object.values(toOrganizationView(withoutRep, 'https://api.example.test').representative).every((x) => x === null)).toBe(true);
	});

	it('membre : nom affiché, et la personne connectée repérée', () => {
		expect(toMember({ id: 'm1', user_id: 'u1', role: 'manager', display_name: 'Mariam Zongo', joined_at: '2026-11-01' }, 'u1')).toEqual({
			id: 'm1',
			userId: 'u1',
			name: 'Mariam Zongo',
			role: 'manager',
			joinedAt: '2026-11-01',
			current: true
		});
	});

	it('tableaux JSON illisibles : liste vide', () => {
		expect(jsonArray('pas du json')).toEqual([]);
		expect(jsonArray(null)).toEqual([]);
	});

	it('fonctionnalités : la même résolution que le serveur, sur les données locales', () => {
		const data = toResolutionData(
			[
				{ id: 'listings.publication', global_mode: 'restricted', plan_bound: 0, requires: '[]' },
				{ id: 'exports.csv', global_mode: 'enabled', plan_bound: 1, requires: '[]' }
			],
			[{ plan_id: 'pro', feature_key: 'exports.csv' }],
			[
				{
					feature_key: 'listings.publication',
					scope: 'organization',
					organization_id: 'org-1',
					user_id: null,
					value: 1,
					starts_at: '2026-01-01T00:00:00Z',
					ends_at: null
				},
				{
					feature_key: 'listings.publication',
					scope: 'user',
					organization_id: null,
					user_id: 'u2',
					value: 0,
					starts_at: '2026-01-01T00:00:00Z',
					ends_at: null
				}
			]
		);
		const now = new Date('2026-11-09T12:00:00Z');
		const director = resolveAll({ organizationId: 'org-1', planId: 'pro', userId: 'u1', disabledByOrganization: [], now }, data);
		expect(director['listings.publication']!.enabled).toBe(true);
		expect(director['exports.csv']!.enabled).toBe(true);
		const other = resolveAll(
			{
				organizationId: 'org-1',
				planId: 'pro',
				userId: 'u2',
				disabledByOrganization: disabledKeys([{ feature_key: 'exports.csv', disabled_by_organization: 1 }]),
				now
			},
			data
		);
		expect(other['listings.publication']!.enabled).toBe(false);
		expect(other['exports.csv']!.reason).toBe('Non — désactivée par l’organisation');
	});

	it('une exception échue ne compte plus, sans attendre le serveur (heure de l’appareil)', () => {
		const data = toResolutionData(
			[{ id: 'listings.publication', global_mode: 'restricted', plan_bound: 0, requires: '[]' }],
			[],
			[
				{
					feature_key: 'listings.publication',
					scope: 'organization',
					organization_id: 'org-1',
					value: 1,
					starts_at: '2026-01-01T00:00:00Z',
					ends_at: '2026-11-01T00:00:00Z'
				}
			]
		);
		const r = resolveAll({ organizationId: 'org-1', planId: 'pro', userId: 'u1', now: new Date('2026-11-09T00:00:00Z') }, data);
		expect(r['listings.publication']!.enabled).toBe(false);
	});
});
