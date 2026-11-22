import { describe, expect, it } from 'vitest';
import { newId } from './ids.js';
import {
	activationBlocker,
	canReportOnLease,
	canRequestLinkFrom,
	createMaintenanceRequestSchema,
	landlordSelfLinkEligible,
	linkPhoneBlocker,
	linkSetFingerprint,
	maintenanceTransitionAllowed,
	ownerVisibleTenant,
	personLinkTransitionAllowed,
	PERSON_LINK_STATUSES,
	PHONE_CHANGE_REVOCATION,
	revokePersonLinkSchema,
	TENANT_FIELDS_HIDDEN_FROM_OWNER,
	updateMaintenanceRequestSchema,
	verifyPersonLinkSchema
} from './person-links.js';

const P = '+22670112233';
const OTHER = '+22676998877';

describe('liaison d’une fiche à une personne (lot 10 ter)', () => {
	it('transitions : demandé → actif ou révoqué ; actif → révoqué ; révoqué ne change plus', () => {
		const allowed = PERSON_LINK_STATUSES.flatMap((from) =>
			PERSON_LINK_STATUSES.filter((to) => personLinkTransitionAllowed(from, to)).map((to) => `${from}>${to}`)
		);
		expect(allowed.sort()).toEqual(['active>revoked', 'requested>active', 'requested>revoked']);
	});

	it('point b : numéro de la fiche différent de celui du compte refusé ; fiche sans numéro refusée ; compte non vérifié refusé', () => {
		expect(linkPhoneBlocker({ recordPhone: P, accountPhone: P, accountPhoneVerified: true })).toBeNull();
		expect(linkPhoneBlocker({ recordPhone: OTHER, accountPhone: P, accountPhoneVerified: true })).toBe('LINK_PHONE_MISMATCH');
		expect(linkPhoneBlocker({ recordPhone: null, accountPhone: P, accountPhoneVerified: true })).toBe('LINK_RECORD_NO_PHONE');
		expect(linkPhoneBlocker({ recordPhone: P, accountPhone: P, accountPhoneVerified: false })).toBe('LINK_ACCOUNT_UNVERIFIED');
	});

	it('activation : jamais sans le code validé ni sans l’acceptation de l’organisation ; numéro de la fiche changé depuis la demande refusé', () => {
		const base = {
			status: 'requested' as const,
			phoneVerified: true,
			accepted: true,
			recordPhone: P,
			linkPhone: P,
			accountPhone: P,
			accountPhoneVerified: true
		};
		expect(activationBlocker(base)).toBeNull();
		expect(activationBlocker({ ...base, phoneVerified: false })).toBe('LINK_CODE_MISSING');
		expect(activationBlocker({ ...base, accepted: false })).toBe('LINK_NOT_ACCEPTED');
		expect(activationBlocker({ ...base, recordPhone: OTHER })).toBe('LINK_PHONE_MISMATCH');
		expect(activationBlocker({ ...base, accountPhone: OTHER })).toBe('LINK_PHONE_MISMATCH');
		expect(activationBlocker({ ...base, status: 'active' })).toBe('LINK_NOT_REQUESTED');
		expect(activationBlocker({ ...base, status: 'revoked' })).toBe('LINK_NOT_REQUESTED');
	});

	it('réponse 1 : une demande ne vise qu’une agence vérifiée, jamais un bailleur particulier', () => {
		expect(canRequestLinkFrom({ type: 'agency', verificationStatus: 'verified' })).toBe(true);
		expect(canRequestLinkFrom({ type: 'agency', verificationStatus: 'pending' })).toBe(false);
		expect(canRequestLinkFrom({ type: 'agency', verificationStatus: 'suspended' })).toBe(false);
		expect(canRequestLinkFrom({ type: 'landlord', verificationStatus: 'verified' })).toBe(false);
	});

	it('réponse 2 : propre fiche du bailleur, par son directeur, au numéro vérifié du compte ; sinon jamais automatique', () => {
		const base = {
			organizationType: 'landlord' as const,
			isDirector: true,
			isSelfRecord: true,
			recordPhone: P,
			accountPhone: P,
			accountPhoneVerified: true
		};
		expect(landlordSelfLinkEligible(base)).toBe(true);
		expect(landlordSelfLinkEligible({ ...base, recordPhone: OTHER })).toBe(false);
		expect(landlordSelfLinkEligible({ ...base, accountPhoneVerified: false })).toBe(false);
		expect(landlordSelfLinkEligible({ ...base, isDirector: false })).toBe(false);
		expect(landlordSelfLinkEligible({ ...base, isSelfRecord: false })).toBe(false);
		expect(landlordSelfLinkEligible({ ...base, organizationType: 'agency' })).toBe(false);
	});

	it('réponse 3 : motifs de révocation à un changement de numéro, les mêmes que ceux écrits par la base', () => {
		expect(PHONE_CHANGE_REVOCATION).toEqual({
			record_phone_changed: 'Numéro de la fiche modifié : la liaison est à refaire.',
			account_phone_changed: 'Numéro du compte modifié : la liaison est à refaire.'
		});
	});

	it('point d : l’empreinte des liens actifs change à chaque révocation, et ne dépend pas de l’ordre', () => {
		const a = { linkId: newId(), organizationId: newId(), recordType: 'owner' as const, recordId: newId() };
		const b = { linkId: newId(), organizationId: newId(), recordType: 'tenant' as const, recordId: newId() };
		expect(linkSetFingerprint([a, b])).toBe(linkSetFingerprint([b, a]));
		expect(linkSetFingerprint([a])).not.toBe(linkSetFingerprint([a, b]));
		expect(linkSetFingerprint([])).toBe('');
		// Un nouveau lien sur la même fiche (après révocation) donne une autre empreinte.
		expect(linkSetFingerprint([{ ...a, linkId: newId() }])).not.toBe(linkSetFingerprint([a]));
	});

	it('réponse 5 et point c : du locataire, le propriétaire ne reçoit que le nom et la civilité', () => {
		const tenant = {
			fullName: 'Salif Traoré',
			civility: 'mr' as const,
			phone: P,
			secondaryPhone: OTHER,
			idNumber: 'B1234567',
			birthDate: '1990-04-12'
		};
		const visible = ownerVisibleTenant(tenant);
		expect(visible).toEqual({ fullName: 'Salif Traoré', civility: 'mr' });
		for (const field of TENANT_FIELDS_HIDDEN_FROM_OWNER) expect(visible).not.toHaveProperty(field);
		expect(JSON.stringify(visible)).not.toContain(P);
		expect(TENANT_FIELDS_HIDDEN_FROM_OWNER).toEqual(expect.arrayContaining(['phone', 'secondaryPhone', 'idNumber', 'birthDate']));
	});

	it('schémas : code de 6 chiffres ; motif de révocation obligatoire', () => {
		expect(verifyPersonLinkSchema.safeParse({ organizationId: newId(), code: '123456' }).success).toBe(true);
		expect(verifyPersonLinkSchema.safeParse({ organizationId: newId(), code: '12345' }).success).toBe(false);
		expect(verifyPersonLinkSchema.safeParse({ code: '123456' }).success).toBe(false);
		expect(revokePersonLinkSchema.safeParse({ reason: 'Fin du mandat' }).success).toBe(true);
		expect(revokePersonLinkSchema.safeParse({ reason: ' ok ' }).success).toBe(false);
	});
});

describe('signalements (lot 10 ter, réponse 4)', () => {
	it('suivi : reçu → planifié → fait, ou reçu → fait ; fait ne change plus', () => {
		expect(maintenanceTransitionAllowed('received', 'planned')).toBe(true);
		expect(maintenanceTransitionAllowed('received', 'done')).toBe(true);
		expect(maintenanceTransitionAllowed('planned', 'done')).toBe(true);
		expect(maintenanceTransitionAllowed('planned', 'received')).toBe(false);
		expect(maintenanceTransitionAllowed('done', 'planned')).toBe(false);
		expect(maintenanceTransitionAllowed('done', 'received')).toBe(false);
	});

	it('seulement pendant le bail (en vigueur ou en préavis)', () => {
		expect(canReportOnLease('active')).toBe(true);
		expect(canReportOnLease('notice')).toBe(true);
		for (const s of ['draft', 'signed', 'ended', 'cancelled']) expect(canReportOnLease(s)).toBe(false);
	});

	it('schémas : titre et description ; « planifié » exige sa date', () => {
		expect(
			createMaintenanceRequestSchema.safeParse({
				id: newId(),
				leaseId: newId(),
				title: 'Fuite',
				description: 'Robinet de la cuisine qui fuit'
			}).success
		).toBe(true);
		expect(createMaintenanceRequestSchema.safeParse({ id: newId(), leaseId: newId(), title: 'Fu', description: 'Robinet' }).success).toBe(
			false
		);
		expect(updateMaintenanceRequestSchema.safeParse({ status: 'planned' }).success).toBe(false);
		expect(updateMaintenanceRequestSchema.safeParse({ status: 'planned', plannedOn: '2026-12-02' }).success).toBe(true);
		expect(updateMaintenanceRequestSchema.safeParse({ status: 'done', statusNote: 'Joint changé' }).success).toBe(true);
	});
});
