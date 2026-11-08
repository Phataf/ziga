/** Matrice de permissions (lot 03) : chaque action, pour chaque rôle, comme le résume le prompt du lot. */
import { describe, expect, it } from 'vitest';
import {
	ACTIONS,
	can,
	memberProfile,
	ORGANIZATION_ROLES,
	PERMISSIONS,
	PLATFORM_ACTIONS,
	PLATFORM_ROLE_KEYS,
	platformCan,
	type Action,
	type OrganizationRole
} from './permissions.js';

const expected: Record<OrganizationRole, Action[]> = {
	director: ACTIONS,
	manager: [
		'organization.read',
		'member.read',
		'property.manage',
		'lease.manage',
		'payment.record',
		'payment.record_cash',
		'payment.validate',
		'reminder.send',
		'listing.publish',
		'lead.manage',
		'visit.manage',
		'photo.upload'
	],
	field_agent: ['organization.read', 'payment.record_cash', 'lead.manage', 'visit.manage', 'photo.upload'],
	viewer: ['organization.read', 'export.csv']
};

describe('matrice de permissions', () => {
	for (const role of ORGANIZATION_ROLES) {
		it(`${role} : exactement les actions prévues`, () => {
			for (const action of ACTIONS) expect(can(role, action), `${role} ${action}`).toBe(expected[role].includes(action));
		});
	}

	it('le gestionnaire n’annule pas un reçu, n’exporte pas et ne gère pas les collaborateurs', () => {
		for (const action of ['receipt.cancel', 'export.csv', 'member.invite', 'member.change_role', 'member.remove'] as const) {
			expect(can('manager', action)).toBe(false);
		}
	});

	it('la lecture ne voit pas l’équipe ; le gestionnaire la voit, sans la modifier', () => {
		expect(can('viewer', 'member.read')).toBe(false);
		expect(can('manager', 'member.read')).toBe(true);
		expect(can('manager', 'invitation.revoke')).toBe(false);
	});

	it('sans rôle, rien n’est permis', () => {
		for (const action of ACTIONS) expect(can(null, action)).toBe(false);
	});

	it('chaque action nomme au moins le directeur', () => {
		for (const roles of Object.values(PERMISSIONS)) expect(roles).toContain('director');
	});

	it('profil de navigation : le bailleur particulier a le sien, l’agence suit le rôle', () => {
		expect(memberProfile('landlord', 'director')).toBe('landlord');
		expect(memberProfile('agency', 'field_agent')).toBe('field_agent');
		expect(memberProfile('agency', 'viewer')).toBe('viewer');
	});
});

describe('matrice des rôles plateforme (lot 04)', () => {
	it('seul le super administrateur modifie les interrupteurs', () => {
		expect(PLATFORM_ROLE_KEYS.filter((r) => platformCan(r, 'feature.manage'))).toEqual(['super_admin']);
	});

	it('assistance : consulter, valider, ouvrir un accès ; jamais suspendre ni toucher aux formules', () => {
		for (const a of ['platform.read', 'organization.verify', 'support.access'] as const) expect(platformCan('support', a)).toBe(true);
		for (const a of [
			'organization.suspend',
			'plan.manage',
			'subscription.manage',
			'subscription.record_payment',
			'feature.manage'
		] as const) {
			expect(platformCan('support', a), a).toBe(false);
		}
	});

	it('commercial : formules et abonnements ; finances : paiements d’abonnement', () => {
		expect(PLATFORM_ACTIONS.filter((a) => platformCan('sales', a)).sort()).toEqual(
			['organization.change_plan', 'plan.manage', 'platform.read', 'subscription.manage'].sort()
		);
		expect(PLATFORM_ACTIONS.filter((a) => platformCan('finance', a)).sort()).toEqual(
			['platform.read', 'subscription.record_payment'].sort()
		);
	});

	it('sans rôle plateforme : rien', () => {
		for (const a of PLATFORM_ACTIONS) expect(platformCan(null, a)).toBe(false);
	});
});
