import { describe, expect, it } from 'vitest';
import {
	allowedDepositHolders,
	allowedLessorTypes,
	canTransitionLease,
	createDepositAccountSchema,
	createLeaseSchema,
	createTenantSchema,
	defaultDepositHolder,
	depositAboveLegalCap,
	depositAccountStatus,
	depositBalances,
	depositHolderChangeSchema,
	depositMovementBlocker,
	depositReceiptSchema,
	LEASE_STATUSES,
	leaseAlerts,
	leaseCreationBlockers,
	leaseOccupancySignal,
	LEGAL_LEASE_DEFAULTS,
	outstandingBalance,
	rentChangeSchema,
	rentDueStatus,
	tenantIdentitySchema,
	unitOccupancy,
	updateLeaseDraftSchema,
	validatedLeaseStatus,
	type LeaseCreationContext,
	type LeaseStatus
} from './leases.js';
import { OCCUPANCIES, type AvailabilityInput } from './properties.js';

const ID = '019a5e2c-7d1e-7c3a-8b2f-1a2b3c4d5e6f';
const ID2 = '019a5e2c-7d1e-7c3a-8b2f-1a2b3c4d5e70';
const TODAY = '2026-11-15';

describe('statut du bail', () => {
	it('validé : signé à venir si le début est futur, en vigueur sinon (décidé par le serveur)', () => {
		expect(validatedLeaseStatus('2026-12-01', TODAY)).toBe('signed');
		expect(validatedLeaseStatus(TODAY, TODAY)).toBe('active');
		expect(validatedLeaseStatus('2024-01-01', TODAY)).toBe('active');
	});
	it('transitions permises seulement', () => {
		expect(canTransitionLease('draft', 'active')).toBe(true);
		expect(canTransitionLease('signed', 'active')).toBe(true);
		expect(canTransitionLease('signed', 'cancelled')).toBe(true);
		expect(canTransitionLease('active', 'cancelled')).toBe(false);
		expect(canTransitionLease('active', 'draft')).toBe(false);
		for (const to of LEASE_STATUSES) {
			expect(canTransitionLease('ended', to)).toBe(false);
			expect(canTransitionLease('cancelled', to)).toBe(false);
		}
	});
});

describe('occupation calculée (règle 13)', () => {
	const l = (status: LeaseStatus, startsOn = '2026-01-01') => ({ status, startsOn });

	it('chaque bail donne son signal', () => {
		expect(leaseOccupancySignal(l('signed', '2026-12-01'), TODAY)).toBe('reserved');
		expect(leaseOccupancySignal(l('signed', TODAY), TODAY)).toBe('occupied');
		expect(leaseOccupancySignal(l('active'), TODAY)).toBe('occupied');
		expect(leaseOccupancySignal(l('notice'), TODAY)).toBe('notice');
		for (const s of ['draft', 'ended', 'cancelled'] as const) expect(leaseOccupancySignal(l(s), TODAY)).toBeNull();
	});

	it('chaque combinaison de baux (réservé, actif, préavis, terminé, annulé, brouillon)', () => {
		const reserved = l('signed', '2027-01-01');
		const cases: [ReturnType<typeof l>[], string][] = [
			[[], 'free'],
			[[l('draft')], 'free'],
			[[l('ended')], 'free'],
			[[l('cancelled'), l('ended')], 'free'],
			[[reserved], 'reserved'],
			[[l('ended'), reserved], 'reserved'],
			[[l('active')], 'occupied'],
			[[l('active'), reserved], 'occupied'],
			[[l('notice')], 'notice'],
			[[l('notice'), reserved], 'notice'],
			[[l('ended'), l('notice')], 'notice'],
			[[l('ended'), l('active')], 'occupied']
		];
		for (const [leases, expected] of cases) expect(unitOccupancy(leases, TODAY), JSON.stringify(leases)).toBe(expected);
	});

	it('l’occupation ne prend jamais d’autre valeur que les quatre prévues', () => {
		for (const s of LEASE_STATUSES) expect(OCCUPANCIES).toContain(unitOccupancy([l(s)], TODAY));
	});
});

describe('garde-fous de création', () => {
	const available: AvailabilityInput = { recordStatus: 'active', occupancy: 'free', technicalStatus: 'ready' };
	const ctx = (over: Partial<LeaseCreationContext>): LeaseCreationContext => ({
		startsOn: '2026-12-01',
		today: TODAY,
		hasManagementMandate: true,
		unit: available,
		otherInForce: false,
		otherReserved: false,
		...over
	});

	it('un bail qui commence aujourd’hui ou plus tard exige une unité disponible, prête comprise', () => {
		expect(leaseCreationBlockers(ctx({}))).toEqual([]);
		expect(leaseCreationBlockers(ctx({ startsOn: TODAY }))).toEqual([]);
		expect(leaseCreationBlockers(ctx({ unit: { ...available, technicalStatus: 'to_refurbish' } }))).toEqual(['UNIT_NOT_AVAILABLE']);
		expect(leaseCreationBlockers(ctx({ startsOn: TODAY, unit: { ...available, technicalStatus: 'under_works' } }))).toEqual([
			'UNIT_NOT_AVAILABLE'
		]);
		expect(leaseCreationBlockers(ctx({ unit: { ...available, recordStatus: 'draft' } }))).toEqual(['UNIT_NOT_AVAILABLE']);
		expect(leaseCreationBlockers(ctx({ unit: { ...available, occupancy: 'occupied' }, otherInForce: true }))).toEqual([
			'UNIT_NOT_AVAILABLE'
		]);
	});

	it('un bail déjà en cours n’exige que l’absence d’un autre bail en vigueur, quel que soit l’état technique', () => {
		const past = { startsOn: '2025-03-01' };
		expect(leaseCreationBlockers(ctx({ ...past, unit: { ...available, technicalStatus: 'unavailable' } }))).toEqual([]);
		expect(leaseCreationBlockers(ctx({ ...past, unit: { ...available, technicalStatus: 'to_refurbish' } }))).toEqual([]);
		expect(leaseCreationBlockers(ctx({ ...past, otherInForce: true, unit: { ...available, occupancy: 'occupied' } }))).toEqual([
			'UNIT_ALREADY_LEASED'
		]);
	});

	it('un mandat de gestion en vigueur est toujours exigé', () => {
		expect(leaseCreationBlockers(ctx({ hasManagementMandate: false }))).toEqual(['NO_MANAGEMENT_MANDATE']);
		expect(leaseCreationBlockers(ctx({ startsOn: '2025-03-01', hasManagementMandate: false }))).toEqual(['NO_MANAGEMENT_MANDATE']);
	});

	it('un seul bail à venir par unité ; un bail à venir sur une unité en préavis est accepté', () => {
		const inNotice = { ...available, occupancy: 'notice' as const };
		expect(leaseCreationBlockers(ctx({ unit: inNotice, otherInForce: true }))).toEqual([]);
		expect(leaseCreationBlockers(ctx({ unit: inNotice, otherInForce: true, otherReserved: true }))).toEqual(['UNIT_ALREADY_RESERVED']);
		// Un bail qui commence aujourd'hui serait en vigueur en même temps que celui en préavis : refusé.
		expect(leaseCreationBlockers(ctx({ startsOn: TODAY, unit: inNotice, otherInForce: true }))).toEqual(['UNIT_ALREADY_LEASED']);
	});
});

describe('alerte « Contrat non signé » (D20)', () => {
	it('bail signé ou en vigueur sans scan de bail signé ; jamais sur un brouillon, un bail terminé ou annulé', () => {
		for (const s of ['signed', 'active', 'notice'] as const) {
			expect(leaseAlerts({ status: s, hasSignedContract: false })).toEqual(['contract_unsigned']);
			expect(leaseAlerts({ status: s, hasSignedContract: true })).toEqual([]);
		}
		for (const s of ['draft', 'ended', 'cancelled'] as const) expect(leaseAlerts({ status: s, hasSignedContract: false })).toEqual([]);
	});
});

describe('statut d’une échéance', () => {
	const due = { dueOn: '2026-12-05', amountDue: 80_000, amountPaid: 0 };
	it('à venir, due le jour même, en retard dès le lendemain', () => {
		expect(rentDueStatus(due, '2026-12-04')).toBe('upcoming');
		expect(rentDueStatus(due, '2026-12-05')).toBe('due');
		expect(rentDueStatus(due, '2026-12-06')).toBe('overdue');
	});
	it('payée en partie reste en retard après sa date ; soldée, jamais en retard', () => {
		expect(rentDueStatus({ ...due, amountPaid: 30_000 }, '2026-12-05')).toBe('partial');
		expect(rentDueStatus({ ...due, amountPaid: 30_000 }, '2026-12-06')).toBe('overdue');
		expect(rentDueStatus({ ...due, amountPaid: 80_000 }, '2027-06-01')).toBe('paid');
		expect(rentDueStatus({ ...due, waived: true }, '2027-06-01')).toBe('waived');
	});
	it('solde du locataire : seulement ce qui est exigible', () => {
		const dues = [
			{ dueOn: '2026-10-05', amountDue: 80_000, amountPaid: 80_000 },
			{ dueOn: '2026-11-05', amountDue: 80_000, amountPaid: 30_000 },
			{ dueOn: '2026-11-15', amountDue: 80_000, amountPaid: 0 },
			{ dueOn: '2026-12-05', amountDue: 80_000, amountPaid: 0 }
		];
		expect(outstandingBalance(dues, TODAY)).toBe(130_000);
	});
});

describe('compte de caution', () => {
	it('versements partiels : reçu, détenu et reste dû justes ; statut déduit', () => {
		const b1 = depositBalances(150_000, [{ type: 'received', amount: 50_000 }]);
		expect(b1).toMatchObject({ received: 50_000, held: 50_000, remainingDue: 100_000 });
		expect(depositAccountStatus(150_000, b1)).toBe('partially_received');
		const b2 = depositBalances(150_000, [
			{ type: 'received', amount: 50_000 },
			{ type: 'received', amount: 100_000 },
			{ type: 'holder_changed', amount: 0 }
		]);
		expect(b2).toMatchObject({ received: 150_000, held: 150_000, remainingDue: 0 });
		expect(depositAccountStatus(150_000, b2)).toBe('held');
		expect(depositAccountStatus(150_000, depositBalances(150_000, []))).toBe('pending');
		expect(depositAccountStatus(150_000, b2, 'settling')).toBe('settling');
	});

	it('refuse un versement au-delà du montant convenu, et des sorties au-delà du reçu', () => {
		const account = { agreedAmount: 150_000, status: 'partially_received' as const };
		const b = depositBalances(150_000, [{ type: 'received', amount: 100_000 }]);
		expect(depositMovementBlocker(account, b, { type: 'received', amount: 50_000 })).toBeNull();
		expect(depositMovementBlocker(account, b, { type: 'received', amount: 50_001 })).toBe('DEPOSIT_OVERPAID');
		expect(depositMovementBlocker(account, b, { type: 'refunded', amount: 100_001 })).toBe('DEPOSIT_OUTFLOW_EXCEEDS_RECEIVED');
		expect(depositMovementBlocker({ ...account, status: 'closed' }, b, { type: 'received', amount: 1 })).toBe('DEPOSIT_ACCOUNT_CLOSED');
	});

	it('plafond de deux mois : loyer seul, caution seulement, la garantie des factures n’y entre pas', () => {
		expect(depositAboveLegalCap('security_deposit', 150_000, 75_000)).toBe(false);
		expect(depositAboveLegalCap('security_deposit', 150_001, 75_000)).toBe(true);
		expect(depositAboveLegalCap('utilities_guarantee', 1_000_000, 75_000)).toBe(false);
	});

	it('détenteur : proposé selon le mandat ; un seul possible pour un bailleur', () => {
		expect(defaultDepositHolder('agency', true)).toBe('organization');
		expect(defaultDepositHolder('agency', false)).toBe('owner');
		expect(defaultDepositHolder('landlord', false)).toBe('organization');
		expect(allowedDepositHolders('landlord')).toEqual(['organization']);
		expect(allowedDepositHolders('agency')).toEqual(['organization', 'owner']);
		expect(allowedLessorTypes('landlord')).toEqual(['organization']);
	});

	it('détenteur obligatoire, montants entiers', () => {
		const base = { id: ID, leaseId: ID2, type: 'security_deposit', agreedAmount: 150_000, holder: 'owner' };
		expect(createDepositAccountSchema.safeParse(base).success).toBe(true);
		expect(createDepositAccountSchema.safeParse({ ...base, holder: undefined }).success).toBe(false);
		expect(createDepositAccountSchema.safeParse({ ...base, agreedAmount: 150_000.5 }).success).toBe(false);
		expect(depositReceiptSchema.safeParse({ id: ID, accountId: ID2, amount: -1, occurredOn: TODAY }).success).toBe(false);
		expect(depositReceiptSchema.safeParse({ id: ID, accountId: ID2, amount: 50_000, occurredOn: TODAY }).success).toBe(true);
		expect(depositHolderChangeSchema.safeParse({ id: ID, accountId: ID2, newHolder: 'owner', occurredOn: TODAY, reason: '' }).success).toBe(
			false
		);
	});
});

describe('schémas du bail', () => {
	const base = { id: ID, unitId: ID2, tenantId: ID, startsOn: '2026-11-17', rent: 75_000, lessorType: 'owner' };

	it('valeurs légales par défaut (à confirmer par le juriste)', () => {
		const data = createLeaseSchema.parse(base);
		expect(data).toMatchObject({
			charges: 0,
			periodicity: 'monthly',
			dueDay: 5,
			billingMode: 'calendar_prorata',
			advanceMonths: 0,
			noticeTenantFixedTermMonths: 2,
			noticeTenantOpenEndedMonths: 3,
			noticeLessorFixedTermMonths: 3,
			noticeLessorOpenEndedMonths: 3,
			renewalMode: 'open_ended',
			depositRefundDays: 30,
			penaltyRateBp: null,
			penaltyGraceDays: null,
			penaltyBeneficiary: null,
			endsOn: null,
			duesStartOn: '2026-11-17',
			validate: true
		});
		expect(LEGAL_LEASE_DEFAULTS.dueDay).toBe(5);
	});

	it('une durée donne la date de fin ; une fin incohérente est refusée', () => {
		expect(createLeaseSchema.parse({ ...base, durationMonths: 12 }).endsOn).toBe('2027-11-16');
		expect(createLeaseSchema.safeParse({ ...base, durationMonths: 12, endsOn: '2027-11-30' }).success).toBe(false);
		expect(createLeaseSchema.safeParse({ ...base, endsOn: '2026-11-01' }).success).toBe(false);
	});

	it('montants : uniquement des entiers FCFA, loyer positif', () => {
		expect(createLeaseSchema.safeParse({ ...base, rent: 75_000.5 }).success).toBe(false);
		expect(createLeaseSchema.safeParse({ ...base, rent: 0 }).success).toBe(false);
		expect(createLeaseSchema.safeParse({ ...base, charges: -1 }).success).toBe(false);
		expect(createLeaseSchema.safeParse({ ...base, rent: '75000' }).success).toBe(false);
		expect(rentChangeSchema.safeParse({ rent: 80_000.1, charges: 0, effectiveFrom: '2027-01-01', expectedVersion: 1 }).success).toBe(false);
	});

	it('jour d’échéance de 1 à 28, mensuel seulement au MVP, avance en mois entiers', () => {
		expect(createLeaseSchema.safeParse({ ...base, dueDay: 29 }).success).toBe(false);
		expect(createLeaseSchema.safeParse({ ...base, periodicity: 'quarterly' }).success).toBe(false);
		expect(createLeaseSchema.safeParse({ ...base, advanceMonths: 1.5 }).success).toBe(false);
	});

	it('facturation pendant le bail ; en anniversaire, un jour anniversaire', () => {
		expect(createLeaseSchema.safeParse({ ...base, duesStartOn: '2026-11-01' }).success).toBe(false);
		expect(createLeaseSchema.safeParse({ ...base, billingMode: 'anniversary', duesStartOn: '2027-01-17' }).success).toBe(true);
		expect(createLeaseSchema.safeParse({ ...base, billingMode: 'anniversary', duesStartOn: '2027-01-01' }).success).toBe(false);
	});

	it('pénalité : taux, délai de grâce et bénéficiaire ensemble, ou aucun', () => {
		expect(createLeaseSchema.safeParse({ ...base, penaltyRateBp: 75 }).success).toBe(false);
		expect(
			createLeaseSchema.safeParse({ ...base, penaltyRateBp: 75, penaltyGraceDays: 10, penaltyBeneficiary: 'organization' }).success
		).toBe(true);
	});

	it('une modification de brouillon ne remet aucune valeur par défaut', () => {
		expect(updateLeaseDraftSchema.parse({ rent: 80_000 })).toEqual({ rent: 80_000 });
	});
});

describe('schémas du locataire', () => {
	it('seul le nom est exigé', () => {
		expect(createTenantSchema.safeParse({ id: ID, fullName: 'Awa Ouédraogo' }).success).toBe(true);
		expect(createTenantSchema.safeParse({ id: ID, fullName: 'A' }).success).toBe(false);
		expect(createTenantSchema.parse({ id: ID, fullName: 'Awa', phone: '70 12 34 56' }).phone).toBe('+22670123456');
	});
	it('pièce d’identité : « autre » demande de préciser', () => {
		expect(tenantIdentitySchema.safeParse({ idType: 'other' }).success).toBe(false);
		expect(tenantIdentitySchema.parse({ idType: 'cnib', idTypeOther: 'x', idNumber: 'B1234567' })).toMatchObject({
			idType: 'cnib',
			idTypeOther: null
		});
	});
});
