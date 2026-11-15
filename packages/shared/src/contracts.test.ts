import { describe, expect, it } from 'vitest';
import {
	automaticRenewalEnd,
	canRegenerate,
	canTransitionContract,
	CONTRACT_STATUSES,
	contractAlerts,
	contractChecks,
	createAmendmentSchema,
	expectedSigners,
	HANDWRITTEN_SCAN_LABEL,
	isFrozen,
	leaseNeedsSignedContract,
	leaseTermAlerts,
	monthlyReminderDue,
	renewalBlocker,
	showDefaultTemplateBanner,
	signatureDatesIssues,
	signatureLabel,
	templateActivationBlocker,
	type ContractCheckInput,
	type ContractForAlerts
} from './contracts.js';

const ID = '019a5e2c-7d1e-7c3a-8b2f-1a2b3c4d5e6f';

describe('cycle du contrat', () => {
	it('brouillon → vérification → prêt à signer → signé ; modifier un contrat figé le renvoie en vérification', () => {
		expect(canTransitionContract('draft', 'in_review')).toBe(true);
		expect(canTransitionContract('in_review', 'draft')).toBe(true);
		expect(canTransitionContract('in_review', 'ready_to_sign')).toBe(true);
		expect(canTransitionContract('ready_to_sign', 'in_review')).toBe(true);
		expect(canTransitionContract('ready_to_sign', 'signed')).toBe(true);
		// Jamais de saut ni de retour depuis « signé ».
		expect(canTransitionContract('draft', 'ready_to_sign')).toBe(false);
		expect(canTransitionContract('draft', 'signed')).toBe(false);
		expect(canTransitionContract('in_review', 'signed')).toBe(false);
		for (const to of CONTRACT_STATUSES) expect(canTransitionContract('signed', to)).toBe(false);
	});

	it('figé : prêt à signer et signé ; la régénération directe n’existe qu’avant le figement', () => {
		expect(CONTRACT_STATUSES.filter(isFrozen)).toEqual(['ready_to_sign', 'signed']);
		expect(CONTRACT_STATUSES.filter(canRegenerate)).toEqual(['draft', 'in_review']);
	});
});

describe('signataires et signature (D21, D24)', () => {
	it('organisation et locataire toujours ; propriétaire s’il est bailleur et que l’organisation ne signe pas pour lui', () => {
		expect(expectedSigners({ lessorType: 'organization', mandateCanSignLeases: false })).toEqual(['organization', 'tenant']);
		expect(expectedSigners({ lessorType: 'owner', mandateCanSignLeases: true })).toEqual(['organization', 'tenant']);
		expect(expectedSigners({ lessorType: 'owner', mandateCanSignLeases: false })).toEqual(['organization', 'owner', 'tenant']);
	});

	it('libellé exact « Signature manuscrite, scan déposé par … le … », jamais « électronique »', () => {
		expect(signatureLabel({ recordedBy: 'Awa Ouédraogo', recordedAt: '2026-11-15T10:00:00Z' })).toBe(
			'Signature manuscrite, scan déposé par Awa Ouédraogo le 15/11/2026'
		);
		expect(signatureLabel({ recordedBy: null, recordedAt: '2026-11-15' })).toBe('Signature manuscrite, scan déposé le 15/11/2026');
		expect(HANDWRITTEN_SCAN_LABEL).not.toMatch(/électroni/i);
		expect(signatureLabel({ recordedBy: 'X', recordedAt: '2026-11-15' })).not.toMatch(/électroni/i);
	});

	it('dates de signature : une par partie attendue, ni dans le futur, ni avant le figement', () => {
		const bounds = { frozenOn: '2026-11-10', today: '2026-11-15' };
		const ok = { organization: '2026-11-12', owner: null, tenant: '2026-11-15' };
		expect(signatureDatesIssues(['organization', 'tenant'], ok, bounds)).toEqual([]);
		expect(signatureDatesIssues(['organization', 'owner', 'tenant'], ok, bounds)).toEqual(['owner']);
		expect(signatureDatesIssues(['organization', 'tenant'], { ...ok, tenant: '2026-11-16' }, bounds)).toEqual(['tenant']);
		expect(signatureDatesIssues(['organization', 'tenant'], { ...ok, organization: '2026-11-09' }, bounds)).toEqual(['organization']);
	});
});

describe('contrôles avant génération et figement', () => {
	const base: ContractCheckInput = {
		leaseStatus: 'draft',
		startsOn: '2027-01-01',
		endsOn: '2027-12-31',
		hasManagementMandate: true,
		rent: 75_000,
		security: { amount: 150_000 },
		signingDate: '2026-12-15',
		amendment: null,
		blankFields: [],
		unknownFields: []
	};

	it('tout est en ordre : ni refus ni avertissement', () => {
		expect(contractChecks(base, 'generate')).toEqual({ blockers: [], warnings: [], blankFields: [], dateIssues: [] });
		expect(contractChecks(base, 'freeze').blockers).toEqual([]);
	});

	it('sans mandat de gestion actif : refus', () => {
		expect(contractChecks({ ...base, hasManagementMandate: false }, 'generate').blockers).toEqual(['NO_MANAGEMENT_MANDATE']);
	});

	it('bail annulé ou terminé : refus', () => {
		for (const leaseStatus of ['cancelled', 'ended'] as const) {
			expect(contractChecks({ ...base, leaseStatus }, 'generate').blockers).toContain('LEASE_NOT_CONTRACTABLE');
		}
	});

	it('champs vides : génération possible avec avertissement, figement refusé, champs nommés', () => {
		const input = { ...base, blankFields: ['organisation.boite_postale'] };
		expect(contractChecks(input, 'generate')).toMatchObject({
			blockers: [],
			warnings: ['MISSING_FIELDS'],
			blankFields: ['organisation.boite_postale']
		});
		expect(contractChecks(input, 'freeze').blockers).toEqual(['MISSING_FIELDS']);
	});

	it('dates incohérentes : refus, avec la raison', () => {
		const r = contractChecks({ ...base, endsOn: '2026-12-31', signingDate: null }, 'generate');
		expect(r.blockers).toEqual(['DATES_INCOHERENT']);
		expect(r.dateIssues).toEqual(['END_BEFORE_START', 'SIGNING_DATE_MISSING']);
		const amendment = contractChecks(
			{ ...base, amendment: { type: 'rent_change', effectiveFrom: '2028-02-01', newEndsOn: null } },
			'generate'
		);
		expect(amendment.dateIssues).toEqual(['AMENDMENT_OUTSIDE_LEASE']);
		const renewal = contractChecks(
			{ ...base, amendment: { type: 'renewal', effectiveFrom: '2028-01-01', newEndsOn: '2027-06-30' } },
			'generate'
		);
		expect(renewal.dateIssues).toEqual(['RENEWAL_NOT_AFTER_END']);
	});

	it('caution au-delà de deux mois de loyer : avertissement, jamais un refus', () => {
		expect(contractChecks({ ...base, security: { amount: 150_000 } }, 'freeze').warnings).toEqual([]);
		const above = contractChecks({ ...base, security: { amount: 150_001 } }, 'freeze');
		expect(above.warnings).toEqual(['DEPOSIT_ABOVE_LEGAL_CAP']);
		expect(above.blockers).toEqual([]);
	});

	it('modèle avec une balise inconnue : refus', () => {
		expect(contractChecks({ ...base, unknownFields: ['client.nom'] }, 'generate').blockers).toEqual(['TEMPLATE_HAS_UNKNOWN_FIELDS']);
	});
});

describe('alertes', () => {
	const lease = { status: 'active' as const, endsOn: '2027-12-31', noticeGivenOn: null, lastAutomaticRenewalOn: null };

	it('fin de bail à 4 mois, puis à 3 mois ; terme dépassé sans congé', () => {
		expect(leaseTermAlerts(lease, '2027-08-30')).toEqual([]);
		expect(leaseTermAlerts(lease, '2027-08-31')).toEqual(['lease_ends_in_4_months']);
		expect(leaseTermAlerts(lease, '2027-09-29')).toEqual(['lease_ends_in_4_months']);
		expect(leaseTermAlerts(lease, '2027-09-30')).toEqual(['lease_ends_in_3_months']);
		expect(leaseTermAlerts(lease, '2027-12-31')).toEqual(['lease_ends_in_3_months']);
		expect(leaseTermAlerts(lease, '2028-01-01')).toEqual(['term_reached_without_notice']);
	});

	it('pas d’alerte de fin avec un préavis, ou pour un bail sans fin ; reconduction signalée 30 jours', () => {
		expect(leaseTermAlerts({ ...lease, noticeGivenOn: '2027-09-01' }, '2027-10-15')).toEqual([]);
		expect(leaseTermAlerts({ ...lease, endsOn: null }, '2027-10-15')).toEqual([]);
		const renewed = { ...lease, endsOn: null, lastAutomaticRenewalOn: '2028-01-01' };
		expect(leaseTermAlerts(renewed, '2028-01-30')).toEqual(['renewed_automatically']);
		expect(leaseTermAlerts(renewed, '2028-01-31')).toEqual([]);
	});

	const contract: ContractForAlerts = {
		status: 'ready_to_sign',
		frozenAt: '2026-11-01T09:00:00Z',
		signedOn: null,
		legalizedOn: null,
		legalizationReminder: true,
		outdated: false,
		isAmendment: false
	};

	it('en attente de signature depuis 7 jours, pas avant', () => {
		expect(contractAlerts(contract, '2026-11-07')).toEqual([]);
		expect(contractAlerts(contract, '2026-11-08')).toEqual(['signature_pending']);
	});

	it('figé mais le bail a changé : à régénérer', () => {
		expect(contractAlerts({ ...contract, outdated: true }, '2026-11-02')).toEqual(['contract_outdated']);
	});

	it('signé non légalisé : rappel mensuel de 7 jours, désactivable, levé par la légalisation', () => {
		const signed = { ...contract, status: 'signed' as const, signedOn: '2026-11-15' };
		expect(contractAlerts(signed, '2026-12-14')).toEqual([]);
		expect(contractAlerts(signed, '2026-12-15')).toEqual(['not_legalized']);
		expect(contractAlerts(signed, '2026-12-21')).toEqual(['not_legalized']);
		expect(contractAlerts(signed, '2026-12-22')).toEqual([]);
		expect(contractAlerts(signed, '2027-01-15')).toEqual(['not_legalized']);
		expect(contractAlerts({ ...signed, legalizationReminder: false }, '2027-01-15')).toEqual([]);
		expect(contractAlerts({ ...signed, legalizedOn: '2026-12-01' }, '2027-01-15')).toEqual([]);
		// 31 janvier : les mois plus courts ramènent au dernier jour.
		expect(monthlyReminderDue('2027-01-31', '2027-02-28')).toBe(true);
	});

	it('avenant à valider ou à signer, jusqu’à sa signature', () => {
		expect(contractAlerts({ ...contract, status: 'draft', isAmendment: true }, '2026-11-02')).toEqual(['amendment_pending']);
		expect(contractAlerts({ ...contract, status: 'signed', signedOn: '2026-11-02', isAmendment: true }, '2026-11-03')).toEqual([]);
	});

	it('« Contrat non signé » : seulement pour un bail signé à venir ou en vigueur', () => {
		expect(['draft', 'signed', 'active', 'notice', 'ended', 'cancelled'].filter((s) => leaseNeedsSignedContract(s as never))).toEqual([
			'signed',
			'active',
			'notice'
		]);
	});
});

describe('modèles', () => {
	it('une balise inconnue bloque l’activation ; un modèle non inspecté ou retiré aussi', () => {
		expect(templateActivationBlocker({ status: 'draft', inspected: true, unknownFields: [] })).toBeNull();
		expect(templateActivationBlocker({ status: 'draft', inspected: true, unknownFields: ['client.nom'] })).toBe(
			'TEMPLATE_HAS_UNKNOWN_FIELDS'
		);
		expect(templateActivationBlocker({ status: 'draft', inspected: false, unknownFields: [] })).toBe('TEMPLATE_NOT_INSPECTED');
		expect(templateActivationBlocker({ status: 'retired', inspected: true, unknownFields: [] })).toBe('TEMPLATE_RETIRED');
	});

	it('bandeau « modèle par défaut non relu » (D25) : pour le modèle de la plateforme seulement', () => {
		expect(showDefaultTemplateBanner('platform', 'lease')).toBe(true);
		expect(showDefaultTemplateBanner('platform', 'amendment')).toBe(true);
		expect(showDefaultTemplateBanner('organization', 'lease')).toBe(false);
	});
});

describe('avenants et reconduction', () => {
	const base = { id: ID, effectiveFrom: '2027-07-01', expectedLeaseVersion: 1 };

	it('changement de loyer : loyer et charges exigés ; seul un avenant de loyer change le loyer', () => {
		expect(createAmendmentSchema.safeParse({ ...base, type: 'rent_change', rent: 80_000, charges: 0 }).success).toBe(true);
		expect(createAmendmentSchema.safeParse({ ...base, type: 'rent_change', rent: 80_000 }).success).toBe(false);
		expect(createAmendmentSchema.safeParse({ ...base, type: 'rent_change', rent: 80_000.5, charges: 0 }).success).toBe(false);
		expect(createAmendmentSchema.safeParse({ ...base, type: 'other', description: 'Ajout d’un garage', rent: 1, charges: 0 }).success).toBe(
			false
		);
	});

	it('renouvellement : une nouvelle fin, ou une durée indéterminée, pas les deux', () => {
		expect(createAmendmentSchema.safeParse({ ...base, type: 'renewal', newEndsOn: '2028-12-31' }).success).toBe(true);
		expect(createAmendmentSchema.safeParse({ ...base, type: 'renewal', openEnded: true }).success).toBe(true);
		expect(createAmendmentSchema.safeParse({ ...base, type: 'renewal' }).success).toBe(false);
		expect(createAmendmentSchema.safeParse({ ...base, type: 'renewal', openEnded: true, newEndsOn: '2028-12-31' }).success).toBe(false);
		expect(createAmendmentSchema.safeParse({ ...base, type: 'other' }).success).toBe(false);
	});

	it('renouvellement : prend effet le lendemain de la fin, la nouvelle fin la suit', () => {
		const lease = { endsOn: '2027-12-31', status: 'active' as const };
		expect(renewalBlocker(lease, { effectiveFrom: '2028-01-01', newEndsOn: '2028-12-31' })).toBeNull();
		expect(renewalBlocker(lease, { effectiveFrom: '2028-01-01', newEndsOn: null })).toBeNull();
		expect(renewalBlocker(lease, { effectiveFrom: '2027-12-01', newEndsOn: '2028-12-31' })).toBe('RENEWAL_EFFECTIVE_DATE');
		expect(renewalBlocker(lease, { effectiveFrom: '2028-01-01', newEndsOn: '2027-12-31' })).toBe('RENEWAL_NOT_AFTER_END');
		expect(renewalBlocker({ ...lease, endsOn: null }, { effectiveFrom: '2028-01-01', newEndsOn: null })).toBe('LEASE_OPEN_ENDED');
		expect(renewalBlocker({ ...lease, status: 'ended' }, { effectiveFrom: '2028-01-01', newEndsOn: null })).toBe('LEASE_NOT_IN_FORCE');
	});

	it('reconduction au terme sans congé, selon le paramètre du bail (D24)', () => {
		const lease = { startsOn: '2027-01-01', endsOn: '2027-12-31', durationMonths: 12 };
		expect(automaticRenewalEnd({ ...lease, renewalMode: 'open_ended' })).toBeNull();
		expect(automaticRenewalEnd({ ...lease, renewalMode: 'same_duration' })).toBe('2028-12-31');
		// Durée déduite des dates (6 mois), sans durée saisie.
		expect(automaticRenewalEnd({ startsOn: '2027-01-01', endsOn: '2027-06-30', durationMonths: null, renewalMode: 'same_duration' })).toBe(
			'2027-12-31'
		);
		// Durée qui n'est pas en mois entiers : le même nombre de jours (20 jours).
		expect(automaticRenewalEnd({ startsOn: '2027-01-01', endsOn: '2027-01-20', durationMonths: null, renewalMode: 'same_duration' })).toBe(
			'2027-02-09'
		);
	});
});
