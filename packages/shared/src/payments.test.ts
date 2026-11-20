/** Encaissements (lot 09) : machine d'états, statut à la saisie, contrôles, doublon Mobile Money, jetons, schémas. */
import { describe, expect, it } from 'vitest';
import { newId } from './ids.js';
import { PAYMENT_METHODS } from './organizations.js';
import {
	assertPaymentTransition,
	base64Url,
	canTransitionPayment,
	duplicateMobileMoneyPayment,
	initialPaymentStatus,
	newReceiptToken,
	normalizeTransactionReference,
	PAYMENT_STATUSES,
	PAYMENT_TRANSITIONS,
	paymentEntryBlockers,
	paymentTransitionAction,
	PaymentTransitionError,
	provisionalReceiptNumber,
	PROVISIONAL_RECEIPT_NUMBER_PATTERN,
	RECEIPT_TOKEN_PATTERN,
	paymentEntrySchema,
	paymentEntriesSchema,
	selectablePaymentMethods,
	ENTERED_PAYMENT_MEANS,
	INTERNAL_PAYMENT_MEANS,
	cancelPaymentSchema,
	type PaymentForDuplicate,
	type PaymentStatus,
	type PaymentEntryInput
} from './payments.js';
import { ORGANIZATION_ROLES } from './permissions.js';

describe('machine d’états du paiement', () => {
	const allowed: [PaymentStatus, PaymentStatus][] = [
		['to_validate', 'confirmed'],
		['to_validate', 'cancelled'],
		['to_reconcile', 'confirmed'],
		['to_reconcile', 'cancelled'],
		['confirmed', 'cancelled'],
		['initiated', 'pending'],
		['initiated', 'confirmed'],
		['initiated', 'failed'],
		['pending', 'confirmed'],
		['pending', 'failed']
	];

	it('exactement les transitions listées ; toute autre est refusée', () => {
		for (const from of PAYMENT_STATUSES) {
			for (const to of PAYMENT_STATUSES) {
				const expected = allowed.some(([a, b]) => a === from && b === to);
				expect(canTransitionPayment(from, to), `${from} → ${to}`).toBe(expected);
			}
		}
	});

	it('transition interdite : erreur nommée (ex. à rapprocher → échoué)', () => {
		expect(() => assertPaymentTransition('to_reconcile', 'failed')).toThrow(PaymentTransitionError);
		try {
			assertPaymentTransition('to_reconcile', 'failed');
		} catch (e) {
			expect((e as PaymentTransitionError).code).toBe('PAYMENT_TRANSITION_FORBIDDEN');
		}
		expect(() => assertPaymentTransition('confirmed', 'to_validate')).toThrow(PaymentTransitionError);
		expect(() => assertPaymentTransition('cancelled', 'confirmed')).toThrow(PaymentTransitionError);
		expect(() => assertPaymentTransition('to_validate', 'confirmed')).not.toThrow();
	});

	it('annulé et échoué sont terminaux', () => {
		expect(PAYMENT_TRANSITIONS.cancelled).toEqual([]);
		expect(PAYMENT_TRANSITIONS.failed).toEqual([]);
	});

	it('permission de chaque transition demandée par une personne', () => {
		expect(paymentTransitionAction('to_validate', 'confirmed')).toBe('payment.validate');
		expect(paymentTransitionAction('to_reconcile', 'confirmed')).toBe('payment.validate');
		expect(paymentTransitionAction('confirmed', 'cancelled')).toBe('payment.cancel');
		expect(paymentTransitionAction('to_validate', 'cancelled')).toBe('payment.cancel');
		// Lot 14 : le prestataire seul.
		expect(paymentTransitionAction('pending', 'confirmed')).toBeNull();
		expect(paymentTransitionAction('to_reconcile', 'failed')).toBeNull();
	});
});

describe('statut décidé par le serveur à la saisie (règle 6)', () => {
	it('espèces : confirmé par la direction ou la gestion, « à valider » pour l’agent de terrain', () => {
		expect(initialPaymentStatus('cash', 'director')).toBe('confirmed');
		expect(initialPaymentStatus('cash', 'manager')).toBe('confirmed');
		expect(initialPaymentStatus('cash', 'field_agent')).toBe('to_validate');
	});
	it('Mobile Money saisi et virement : « à rapprocher », quel que soit le rôle', () => {
		for (const role of ['director', 'manager'] as const) {
			expect(initialPaymentStatus('mobile_money_manual', role)).toBe('to_reconcile');
			expect(initialPaymentStatus('bank_transfer', role)).toBe('to_reconcile');
		}
	});
	it('paiement direct : initié (lot 14)', () => {
		expect(initialPaymentStatus('mobile_money_direct', 'director')).toBe('initiated');
	});
	it('imputation sur caution (lot 10 bis, D32) : confirmée par le serveur, sur le décompte ou l’accord', () => {
		expect(initialPaymentStatus('deposit_offset', 'director')).toBe('confirmed');
	});
});

describe('imputation sur caution : moyen interne, jamais saisi (D32)', () => {
	const base = { acceptedMethods: PAYMENT_METHODS, paidOn: '2027-01-05', today: '2027-01-05' };
	it('pas un moyen de l’organisation (D18) : ni proposé, ni accepté d’une saisie, ni par le schéma', () => {
		expect((PAYMENT_METHODS as readonly string[]).includes('deposit_offset')).toBe(false);
		expect(INTERNAL_PAYMENT_MEANS).toEqual(['deposit_offset']);
		expect((ENTERED_PAYMENT_MEANS as readonly string[]).includes('deposit_offset')).toBe(false);
		for (const role of ORGANIZATION_ROLES) {
			expect((selectablePaymentMethods(PAYMENT_METHODS, role) as string[]).includes('deposit_offset')).toBe(false);
		}
		expect(paymentEntryBlockers({ ...base, role: 'director', method: 'deposit_offset' })).toEqual(['PAYMENT_METHOD_INTERNAL']);
		const receiptId = newId();
		const entry = {
			id: newId(),
			leaseId: newId(),
			purpose: 'rent',
			amount: 80_000,
			method: 'deposit_offset',
			paidOn: '2027-01-05',
			receiptId,
			provisionalNumber: provisionalReceiptNumber(receiptId),
			verificationToken: newReceiptToken(),
			shareToken: newReceiptToken()
		};
		expect(paymentEntrySchema.safeParse(entry).success).toBe(false);
		expect(paymentEntrySchema.safeParse({ ...entry, method: 'cash' }).success).toBe(true);
	});
});

describe('contrôles d’une saisie', () => {
	const base = { role: 'manager' as const, acceptedMethods: PAYMENT_METHODS, paidOn: '2027-01-05', today: '2027-01-05' };
	it('moyen non accepté par l’organisation : refusé, et absent de l’écran', () => {
		expect(paymentEntryBlockers({ ...base, method: 'bank_transfer', acceptedMethods: ['cash', 'mobile_money_manual'] })).toEqual([
			'PAYMENT_METHOD_NOT_ACCEPTED'
		]);
		expect(selectablePaymentMethods(['cash', 'mobile_money_manual'], 'manager')).toEqual(['cash', 'mobile_money_manual']);
	});
	it('agent de terrain : espèces seulement ; profil lecture : rien', () => {
		expect(paymentEntryBlockers({ ...base, role: 'field_agent', method: 'cash' })).toEqual([]);
		expect(paymentEntryBlockers({ ...base, role: 'field_agent', method: 'mobile_money_manual' })).toEqual(['FORBIDDEN_ACTION']);
		expect(paymentEntryBlockers({ ...base, role: 'viewer', method: 'cash' })).toEqual(['FORBIDDEN_ACTION']);
		expect(selectablePaymentMethods(PAYMENT_METHODS, 'field_agent')).toEqual(['cash']);
		expect(selectablePaymentMethods(PAYMENT_METHODS, 'viewer')).toEqual([]);
	});
	it('paiement direct indisponible au lot 09 ; date future refusée', () => {
		expect(paymentEntryBlockers({ ...base, role: 'director', method: 'mobile_money_direct' })).toEqual(['PAYMENT_METHOD_UNAVAILABLE']);
		expect(paymentEntryBlockers({ ...base, method: 'cash', paidOn: '2027-01-06' })).toEqual(['PAYMENT_DATE_IN_FUTURE']);
	});
	it('le directeur et le gestionnaire encaissent tous les moyens acceptés', () => {
		for (const role of ORGANIZATION_ROLES.filter((r) => r === 'director' || r === 'manager')) {
			expect(selectablePaymentMethods(PAYMENT_METHODS, role)).toEqual([...PAYMENT_METHODS]);
		}
	});
});

describe('doublon Mobile Money (point b)', () => {
	const prior: PaymentForDuplicate = {
		id: newId(),
		kind: 'payment',
		method: 'mobile_money_manual',
		operator: 'orange_money',
		transactionReference: 'MP231116.1234.A12',
		status: 'to_reconcile'
	};
	const candidate = {
		id: newId(),
		method: 'mobile_money_manual' as const,
		operator: 'orange_money' as const,
		transactionReference: ' mp 2311161234-a12 '
	};

	it('référence normalisée : majuscules, sans espaces ni séparateurs', () => {
		expect(normalizeTransactionReference(' mp 231116.1234-a12 ')).toBe('MP2311161234A12');
	});
	it('même opérateur, même référence : doublon', () => {
		expect(duplicateMobileMoneyPayment([prior], candidate)).toBe(prior);
		expect(duplicateMobileMoneyPayment([{ ...prior, status: 'confirmed' }], candidate)).not.toBeNull();
	});
	it('permis si le précédent est annulé, si l’opérateur diffère, ou pour la contre-écriture', () => {
		expect(duplicateMobileMoneyPayment([{ ...prior, status: 'cancelled' }], candidate)).toBeNull();
		expect(duplicateMobileMoneyPayment([{ ...prior, operator: 'moov_money' }], candidate)).toBeNull();
		expect(duplicateMobileMoneyPayment([{ ...prior, kind: 'reversal' }], candidate)).toBeNull();
	});
	it('un encaissement n’est pas son propre doublon (rejeu) ; les espèces ne sont pas concernées', () => {
		expect(duplicateMobileMoneyPayment([prior], { ...candidate, id: prior.id })).toBeNull();
		expect(duplicateMobileMoneyPayment([prior], { ...candidate, method: 'cash' })).toBeNull();
	});
});

describe('jetons et numéro provisoire', () => {
	it('base64url conforme à Node (sans remplissage)', () => {
		for (let n = 0; n < 40; n += 1) {
			const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n * 11) % 256);
			expect(base64Url(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
		}
	});
	it('jeton de 256 bits en base64url, jamais deux fois le même', () => {
		const tokens = new Set(Array.from({ length: 500 }, () => newReceiptToken()));
		expect(tokens.size).toBe(500);
		for (const t of tokens) {
			expect(t).toMatch(RECEIPT_TOKEN_PATTERN);
			expect(t).toHaveLength(43);
		}
	});
	it('un jeton de moins de 128 bits est refusé', () => {
		expect(RECEIPT_TOKEN_PATTERN.test('a'.repeat(21))).toBe(false);
		expect(RECEIPT_TOKEN_PATTERN.test('a'.repeat(22))).toBe(true);
	});
	it('numéro provisoire : PROV- et six caractères de l’identifiant', () => {
		const id = '01936f6e-8c1a-7cc0-8f3a-2b9d4e7f3a1c';
		expect(provisionalReceiptNumber(id)).toBe('PROV-7F3A1C');
		expect(provisionalReceiptNumber(newId())).toMatch(PROVISIONAL_RECEIPT_NUMBER_PATTERN);
	});
});

describe('schémas de saisie', () => {
	const receiptId = newId();
	const valid: PaymentEntryInput = {
		id: newId(),
		leaseId: newId(),
		purpose: 'rent',
		amount: 85_000,
		method: 'cash',
		paidOn: '2027-01-05',
		receiptId,
		provisionalNumber: provisionalReceiptNumber(receiptId),
		verificationToken: newReceiptToken(),
		shareToken: newReceiptToken()
	};

	it('espèces sur un loyer', () => {
		expect(paymentEntrySchema.parse(valid)).toMatchObject({
			depositAccountId: null,
			operator: null,
			transactionReference: null,
			note: null
		});
	});
	it('montants : entiers FCFA strictement positifs (règle 2)', () => {
		for (const amount of [0, -1, 1.5, 85_000.5]) expect(paymentEntrySchema.safeParse({ ...valid, amount }).success).toBe(false);
	});
	it('Mobile Money : opérateur et référence obligatoires ; espèces : ni l’un ni l’autre', () => {
		expect(paymentEntrySchema.safeParse({ ...valid, method: 'mobile_money_manual' }).success).toBe(false);
		expect(
			paymentEntrySchema.safeParse({ ...valid, method: 'mobile_money_manual', operator: 'orange_money', transactionReference: 'MP1' })
				.success
		).toBe(true);
		expect(paymentEntrySchema.safeParse({ ...valid, operator: 'orange_money' }).success).toBe(false);
		expect(paymentEntrySchema.safeParse({ ...valid, transactionReference: 'X' }).success).toBe(false);
		expect(paymentEntrySchema.safeParse({ ...valid, method: 'bank_transfer', transactionReference: 'VIR-1' }).success).toBe(true);
	});
	it('caution : compte obligatoire ; loyer : jamais de compte', () => {
		expect(paymentEntrySchema.safeParse({ ...valid, purpose: 'deposit' }).success).toBe(false);
		expect(paymentEntrySchema.safeParse({ ...valid, purpose: 'deposit', depositAccountId: newId() }).success).toBe(true);
		expect(paymentEntrySchema.safeParse({ ...valid, depositAccountId: newId() }).success).toBe(false);
	});
	it('deux jetons distincts, chacun d’au moins 128 bits', () => {
		expect(paymentEntrySchema.safeParse({ ...valid, shareToken: valid.verificationToken }).success).toBe(false);
		expect(paymentEntrySchema.safeParse({ ...valid, shareToken: 'court' }).success).toBe(false);
	});
	it('« Caution et avance » : deux encaissements du même bail, un objet chacun', () => {
		const deposit = { ...valid, id: newId(), purpose: 'deposit' as const, depositAccountId: newId() };
		expect(paymentEntriesSchema.safeParse({ payments: [deposit, valid] }).success).toBe(true);
		expect(paymentEntriesSchema.safeParse({ payments: [valid, { ...valid, id: newId() }] }).success).toBe(false);
		expect(paymentEntriesSchema.safeParse({ payments: [deposit, { ...valid, leaseId: newId() }] }).success).toBe(false);
	});
	it('annulation : motif obligatoire', () => {
		expect(cancelPaymentSchema.safeParse({ reason: '' }).success).toBe(false);
		expect(cancelPaymentSchema.safeParse({ reason: '   ok  ' }).success).toBe(false);
		expect(cancelPaymentSchema.parse({ reason: ' Erreur de locataire ' })).toEqual({ reason: 'Erreur de locataire' });
	});
});
