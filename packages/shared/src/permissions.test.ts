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
		'owner.read',
		'owner.create',
		'owner.update',
		'mandate.read',
		'mandate.create',
		'mandate.update',
		'mandate.revoke',
		'property.read',
		'property.manage',
		'unit.assign',
		'unit.status',
		'document.read',
		'document.upload',
		'document.withdraw',
		'tenant.read',
		'tenant.read_identity',
		'tenant.create',
		'tenant.update',
		'lease.read',
		'lease.create',
		'lease.update',
		'deposit.read',
		'deposit.receive',
		'contract.read',
		'contract.create',
		'contract.freeze',
		'contract.upload_signed',
		'contract_template.read',
		'payment.read',
		'payment.record',
		'payment.record_cash',
		'payment.validate',
		'receipt.share',
		'reminder.read',
		'reminder.send',
		'reminder.record_visit',
		'expense.read',
		'expense.record',
		'statement.read',
		'statement.issue',
		'statement.share',
		'payout.record',
		'listing.publish',
		'lead.manage',
		'visit.manage',
		'photo.upload'
	],
	// Lot 06 : propriétaires et mandats en lecture seule. Lot 07 : ses unités affectées (état technique, photos), aucun document.
	// Lot 08 : baux et locataires de ses unités, sans état civil ni caution.
	field_agent: [
		'organization.read',
		'owner.read',
		'mandate.read',
		'property.read',
		'unit.status',
		'tenant.read',
		'lease.read',
		'payment.read',
		'payment.record_cash',
		'receipt.share',
		'reminder.read',
		'reminder.record_visit',
		'lead.manage',
		'visit.manage',
		'photo.upload'
	],
	// Lot 07 : biens et unités en lecture, aucun document privé.
	// Lot 08 : locataires (sans état civil), baux et cautions en lecture. Lot 09 : encaissements et reçus en lecture.
	viewer: [
		'organization.read',
		'owner.read',
		'mandate.read',
		'property.read',
		'tenant.read',
		'lease.read',
		'deposit.read',
		'payment.read',
		'reminder.read',
		'expense.read',
		'statement.read',
		'export.csv'
	]
};

describe('matrice de permissions', () => {
	for (const role of ORGANIZATION_ROLES) {
		it(`${role} : exactement les actions prévues`, () => {
			for (const action of ACTIONS) expect(can(role, action), `${role} ${action}`).toBe(expected[role].includes(action));
		});
	}

	it('seul le directeur annule un encaissement et règle la numérotation des reçus ; l’agent de terrain n’encaisse que des espèces', () => {
		for (const role of ORGANIZATION_ROLES) {
			expect(can(role, 'payment.cancel')).toBe(role === 'director');
			expect(can(role, 'receipt.settings')).toBe(role === 'director');
		}
		expect(can('field_agent', 'payment.record_cash')).toBe(true);
		expect(can('field_agent', 'payment.record')).toBe(false);
		expect(can('field_agent', 'payment.validate')).toBe(false);
		expect(can('viewer', 'payment.record_cash')).toBe(false);
		expect((ACTIONS as string[]).includes('receipt.cancel')).toBe(false);
	});

	it('le gestionnaire n’annule pas un reçu, n’exporte pas et ne gère pas les collaborateurs', () => {
		for (const action of ['payment.cancel', 'export.csv', 'member.invite', 'member.change_role', 'member.remove'] as const) {
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
	it('référentiel géographique (lot 07) : super administrateur et assistance seulement', () => {
		expect(PLATFORM_ROLE_KEYS.filter((r) => platformCan(r, 'geography.manage'))).toEqual(['super_admin', 'support']);
	});

	it('préfixe des reçus après le premier reçu (lot 09) : super administrateur seulement', () => {
		expect(PLATFORM_ROLE_KEYS.filter((r) => platformCan(r, 'receipt.prefix_override'))).toEqual(['super_admin']);
	});

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
