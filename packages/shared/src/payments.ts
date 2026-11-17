/**
 * Encaissements (lot 09) : machine d'états du paiement, statut décidé par le serveur, contrôles d'une saisie,
 * doublon Mobile Money, jetons des reçus, schémas et vues partagés par l'API, le worker et l'appareil.
 *
 * Règles de CLAUDE.md : montants en entiers FCFA (règle 2) ; un paiement validé n'est jamais modifié ni supprimé, une
 * erreur se corrige par une contre-écriture (règle 3) ; un paiement n'est « confirmé » que sur preuve (règle 6) ;
 * désactiver une fonctionnalité n'interrompt pas un paiement en cours (règle 10).
 */
import { z } from 'zod';
import { isIsoDate } from './dates.js';
import { idSchema } from './ids.js';
import { fcfaSchema, type Fcfa } from './money.js';
import { PAYMENT_METHODS, type PaymentMethod } from './organizations.js';
import { can, type Action, type OrganizationRole } from './permissions.js';

// ---------------------------------------------------------------- moyens, opérateurs, objets

/**
 * Moyens d'un encaissement : les trois moyens du registre (réglage de l'organisation, D18) et le paiement initié depuis
 * la plateforme, réservé au lot 14 (`payments.direct`).
 */
export const PAYMENT_MEANS = [...PAYMENT_METHODS, 'mobile_money_direct'] as const;
export type PaymentMeans = (typeof PAYMENT_MEANS)[number];

export const MOBILE_MONEY_OPERATORS = ['orange_money', 'moov_money', 'other'] as const;
export type MobileMoneyOperator = (typeof MOBILE_MONEY_OPERATORS)[number];

/** Un encaissement a un seul objet : le loyer d'un bail, ou le versement sur un compte de caution (réponse du porteur). */
export const PAYMENT_PURPOSES = ['rent', 'deposit', 'expense'] as const;
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

/** `reversal` : la contre-écriture d'un paiement annulé, liée à lui ; jamais saisie, jamais imputée. */
export const PAYMENT_KINDS = ['payment', 'reversal'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

/** Prestataire : `manual` pour le registre ; la clé d'un agrégateur au lot 14. */
export const MANUAL_PROVIDER = 'manual';

// ---------------------------------------------------------------- machine d'états (source unique)

export const PAYMENT_STATUSES = ['to_validate', 'to_reconcile', 'confirmed', 'initiated', 'pending', 'failed', 'cancelled'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Statuts réservés au paiement direct (lot 14) : déclarés, jamais produits par le registre. */
export const DIRECT_PAYMENT_STATUSES = ['initiated', 'pending', 'failed'] as const satisfies readonly PaymentStatus[];

/** Statuts qui attendent une preuve ou une décision : ni imputés, ni numérotés. */
export const AWAITING_PAYMENT_STATUSES = ['to_validate', 'to_reconcile'] as const satisfies readonly PaymentStatus[];

/** Statuts terminaux. */
export const FINAL_PAYMENT_STATUSES = ['failed', 'cancelled'] as const satisfies readonly PaymentStatus[];

/**
 * Chaque transition permise ; toute autre est refusée (`PAYMENT_TRANSITION_FORBIDDEN`). La base applique la même liste
 * (trigger de la migration 0015, comparé à celle-ci par un test).
 *
 * - `to_validate` → `confirmed` : espèces d'un agent de terrain validées par la direction ou la gestion.
 * - `to_reconcile` → `confirmed` : Mobile Money ou virement saisi à la main, rapproché.
 * - `confirmed` → `cancelled` : contre-écriture motivée, par le directeur.
 * - Un encaissement en attente peut aussi être annulé (motif, directeur), sans contre-écriture d'imputation : il n'en a
 *   aucune.
 * - Lot 14 : `initiated` → `pending` → `confirmed` ou `failed`, `confirmed` seulement sur notification signée ou
 *   vérification auprès du prestataire.
 */
export const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
	to_validate: ['confirmed', 'cancelled'],
	to_reconcile: ['confirmed', 'cancelled'],
	confirmed: ['cancelled'],
	initiated: ['pending', 'confirmed', 'failed'],
	pending: ['confirmed', 'failed'],
	failed: [],
	cancelled: []
};

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
	return PAYMENT_TRANSITIONS[from].includes(to);
}

export class PaymentTransitionError extends Error {
	readonly code = 'PAYMENT_TRANSITION_FORBIDDEN';
	constructor(
		readonly from: PaymentStatus,
		readonly to: PaymentStatus
	) {
		super(`Transition refusée : ${from} → ${to}.`);
		this.name = 'PaymentTransitionError';
	}
}

/** Lève `PaymentTransitionError` si la transition n'est pas listée. */
export function assertPaymentTransition(from: PaymentStatus, to: PaymentStatus): void {
	if (!canTransitionPayment(from, to)) throw new PaymentTransitionError(from, to);
}

/**
 * Permission exigée pour une transition demandée par une personne. Les transitions du paiement direct ne sont jamais
 * demandées par une personne : elles viennent du prestataire (lot 14), d'où `null`.
 */
export function paymentTransitionAction(from: PaymentStatus, to: PaymentStatus): Action | null {
	if (!canTransitionPayment(from, to)) return null;
	if (to === 'cancelled') return 'payment.cancel';
	if (to === 'confirmed' && (from === 'to_validate' || from === 'to_reconcile')) return 'payment.validate';
	return null;
}

/**
 * Statut d'un encaissement à sa saisie, décidé par le serveur seul (règle 6) : l'appareil n'envoie jamais de statut.
 * - Espèces saisies par la direction ou la gestion : `confirmed`.
 * - Espèces saisies par un agent de terrain : `to_validate`.
 * - Mobile Money saisi ou virement : `to_reconcile`, quel que soit le rôle.
 * - Paiement direct : `initiated` (lot 14).
 */
export function initialPaymentStatus(method: PaymentMeans, role: OrganizationRole): PaymentStatus {
	switch (method) {
		case 'cash':
			return can(role, 'payment.validate') ? 'confirmed' : 'to_validate';
		case 'mobile_money_manual':
		case 'bank_transfer':
			return 'to_reconcile';
		case 'mobile_money_direct':
			return 'initiated';
	}
}

// ---------------------------------------------------------------- contrôles d'une saisie

export type PaymentEntryBlocker =
	/** Moyen absent des moyens acceptés par l'organisation (D18). */
	| 'PAYMENT_METHOD_NOT_ACCEPTED'
	/** Paiement initié depuis la plateforme : lot 14. */
	| 'PAYMENT_METHOD_UNAVAILABLE'
	/** Le rôle ne peut pas encaisser ce moyen (l'agent de terrain : espèces seulement ; le profil lecture : rien). */
	| 'FORBIDDEN_ACTION'
	/** Date du paiement dans le futur. */
	| 'PAYMENT_DATE_IN_FUTURE';

export interface PaymentEntryContext {
	method: PaymentMeans;
	role: OrganizationRole;
	acceptedMethods: readonly PaymentMethod[];
	paidOn: string;
	today: string;
}

/** Permission exigée pour saisir un encaissement avec ce moyen. */
export function paymentRecordAction(method: PaymentMeans): Action {
	return method === 'cash' ? 'payment.record_cash' : 'payment.record';
}

/** Contrôles d'une saisie, avant la base, dans l'ordre où le serveur les applique. */
export function paymentEntryBlockers(ctx: PaymentEntryContext): PaymentEntryBlocker[] {
	const out: PaymentEntryBlocker[] = [];
	if (!can(ctx.role, paymentRecordAction(ctx.method))) out.push('FORBIDDEN_ACTION');
	if (ctx.method === 'mobile_money_direct') out.push('PAYMENT_METHOD_UNAVAILABLE');
	else if (!ctx.acceptedMethods.includes(ctx.method)) out.push('PAYMENT_METHOD_NOT_ACCEPTED');
	if (ctx.paidOn > ctx.today) out.push('PAYMENT_DATE_IN_FUTURE');
	return out;
}

/** Moyens proposés à l'écran : ceux que l'organisation accepte et que le rôle peut encaisser (le serveur décide). */
export function selectablePaymentMethods(acceptedMethods: readonly PaymentMethod[], role: OrganizationRole): PaymentMethod[] {
	return PAYMENT_METHODS.filter((m) => acceptedMethods.includes(m) && can(role, paymentRecordAction(m)));
}

// ---------------------------------------------------------------- doublon Mobile Money

/**
 * Référence de transaction normalisée : majuscules, sans espaces ni séparateurs (point, tiret, barre, soulignement),
 * pour qu'une même transaction saisie « MP231116.1234.A12 » puis « mp 2311161234 a12 » soit reconnue.
 */
export function normalizeTransactionReference(reference: string): string {
	return reference
		.normalize('NFKC')
		.toUpperCase()
		.replace(/[\s._\-/]+/g, '');
}

export interface PaymentForDuplicate {
	id: string;
	kind: PaymentKind;
	method: PaymentMeans;
	operator: MobileMoneyOperator | null;
	transactionReference: string | null;
	status: PaymentStatus;
}

/**
 * Une même référence chez le même opérateur ne peut pas être saisie deux fois dans une organisation, sauf si le
 * paiement précédent est annulé (point b du porteur). La base applique la même règle par un index unique partiel ;
 * l'appareil s'en sert pour prévenir avant l'envoi.
 */
export function duplicateMobileMoneyPayment<T extends PaymentForDuplicate>(
	existing: readonly T[],
	candidate: Pick<PaymentForDuplicate, 'id' | 'method' | 'operator' | 'transactionReference'>
): T | null {
	if (candidate.method !== 'mobile_money_manual' || !candidate.operator || !candidate.transactionReference) return null;
	const ref = normalizeTransactionReference(candidate.transactionReference);
	return (
		existing.find(
			(p) =>
				p.id !== candidate.id &&
				p.kind === 'payment' &&
				p.method === 'mobile_money_manual' &&
				p.status !== 'cancelled' &&
				p.operator === candidate.operator &&
				p.transactionReference !== null &&
				normalizeTransactionReference(p.transactionReference) === ref
		) ?? null
	);
}

// ---------------------------------------------------------------- jetons des reçus

/**
 * Deux jetons par reçu (réponse du porteur) : le jeton de vérification (QR code, page `/r/<jeton>` minimale) et le
 * jeton de partage (lien WhatsApp, page `/recu/<jeton>`, révocable). 32 octets aléatoires (256 bits, au moins 128
 * exigés) en base64url, créés sur l'appareil pour partager hors ligne ; le serveur n'en garde que l'empreinte SHA-256.
 */
export const RECEIPT_TOKEN_BYTES = 32;
/** 16 octets au moins (128 bits) : 22 caractères base64url ; 64 octets au plus. */
export const RECEIPT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,86}$/;

const BASE64_URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Octets en base64url, sans remplissage (sans dépendre de `btoa`, absent des types de Node). */
export function base64Url(bytes: Uint8Array): string {
	let out = '';
	for (let i = 0; i < bytes.length; i += 3) {
		const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
		const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
		for (let c = 0; c < chars; c += 1) out += BASE64_URL[(n >> (18 - 6 * c)) & 63];
	}
	return out;
}

/** `crypto.getRandomValues`, présent dans le navigateur et dans Node (Web Crypto). */
const webCrypto = (globalThis as unknown as { crypto: { getRandomValues<T extends Uint8Array>(array: T): T } }).crypto;

/** Nouveau jeton, par `crypto.getRandomValues` (navigateur et Node). */
export function newReceiptToken(): string {
	return base64Url(webCrypto.getRandomValues(new Uint8Array(RECEIPT_TOKEN_BYTES)));
}

export const receiptTokenSchema = z.string().regex(RECEIPT_TOKEN_PATTERN, { error: 'Jeton de reçu invalide.' });

// ---------------------------------------------------------------- schémas

const isoDate = z.string().refine(isIsoDate, { error: 'Date invalide.' });
const optionalText = (max: number) =>
	z
		.string()
		.trim()
		.max(max, { error: 'Champ trop long.' })
		.nullish()
		.transform((v) => (v ? v : null));

/** Numéro provisoire affiché par l'appareil jusqu'à la synchronisation : `PROV-` et 6 caractères. */
export const PROVISIONAL_RECEIPT_NUMBER_PATTERN = /^PROV-[0-9A-F]{6}$/;

/**
 * Numéro provisoire d'un reçu créé sur l'appareil : les six derniers caractères de son identifiant (partie aléatoire
 * de l'UUIDv7). Il sert à reconnaître le reçu en attendant le numéro définitif ; il n'est jamais unique ni continu.
 */
export function provisionalReceiptNumber(receiptId: string): string {
	return `PROV-${receiptId.replaceAll('-', '').slice(-6).toUpperCase()}`;
}

const paymentEntryFields = {
	id: idSchema,
	leaseId: idSchema,
	purpose: z.enum(PAYMENT_PURPOSES),
	depositAccountId: idSchema.nullish().transform((v) => v ?? null),
	/** Lot 10 : dépense réclamée au locataire que cet encaissement rembourse (objet `expense`). */
	expenseId: idSchema.nullish().transform((v) => v ?? null),
	amount: fcfaSchema.min(1, { error: 'Indiquez le montant.' }),
	method: z.enum(PAYMENT_MEANS, { error: 'Choisissez le moyen de paiement.' }),
	operator: z
		.enum(MOBILE_MONEY_OPERATORS)
		.nullish()
		.transform((v) => v ?? null),
	transactionReference: optionalText(60),
	paidOn: isoDate,
	note: optionalText(500),
	/** Reçu créé avec l'encaissement, sur l'appareil ; son numéro définitif vient du serveur à la confirmation. */
	receiptId: idSchema,
	provisionalNumber: z.string().regex(PROVISIONAL_RECEIPT_NUMBER_PATTERN, { error: 'Numéro provisoire invalide.' }),
	verificationToken: receiptTokenSchema,
	shareToken: receiptTokenSchema
};

/**
 * Saisie d'un encaissement (écran, route HTTP et synchronisation). Ni statut, ni locataire, ni numéro : le serveur les
 * décide (le locataire vient du bail).
 */
export const paymentEntrySchema = z.object(paymentEntryFields).superRefine((p, ctx) => {
	if (p.purpose === 'deposit' && !p.depositAccountId) {
		ctx.addIssue({ code: 'custom', path: ['depositAccountId'], message: 'Choisissez le compte de caution.' });
	}
	if (p.purpose === 'rent' && p.depositAccountId) {
		ctx.addIssue({ code: 'custom', path: ['depositAccountId'], message: 'Un encaissement de loyer ne vise pas un compte de caution.' });
	}
	if (p.purpose === 'expense' && !p.expenseId) {
		ctx.addIssue({ code: 'custom', path: ['expenseId'], message: 'Choisissez la dépense remboursée.' });
	}
	if (p.purpose !== 'expense' && p.expenseId) {
		ctx.addIssue({ code: 'custom', path: ['expenseId'], message: 'Seul un remboursement de dépense vise une dépense.' });
	}
	if (p.purpose === 'expense' && p.depositAccountId) {
		ctx.addIssue({ code: 'custom', path: ['depositAccountId'], message: 'Un remboursement de dépense ne vise pas un compte de caution.' });
	}
	if (p.method === 'mobile_money_manual' || p.method === 'mobile_money_direct') {
		if (!p.operator) ctx.addIssue({ code: 'custom', path: ['operator'], message: 'Choisissez l’opérateur.' });
		if (!p.transactionReference) {
			ctx.addIssue({ code: 'custom', path: ['transactionReference'], message: 'Indiquez la référence de la transaction.' });
		}
	} else if (p.operator) {
		ctx.addIssue({ code: 'custom', path: ['operator'], message: 'L’opérateur ne concerne que le Mobile Money.' });
	}
	if (p.method === 'cash' && p.transactionReference) {
		ctx.addIssue({ code: 'custom', path: ['transactionReference'], message: 'Un paiement en espèces n’a pas de référence.' });
	}
	if (p.verificationToken === p.shareToken) {
		ctx.addIssue({ code: 'custom', path: ['shareToken'], message: 'Les deux jetons du reçu sont distincts.' });
	}
});
export type PaymentEntryInput = z.input<typeof paymentEntrySchema>;
export type PaymentEntryData = z.output<typeof paymentEntrySchema>;

/**
 * « Caution et avance » à la signature : une seule saisie qui crée deux encaissements et deux reçus, dans une même
 * validation (réponse du porteur). Chacun garde un seul objet.
 */
export const paymentEntriesSchema = z.object({ payments: z.array(paymentEntrySchema).min(1).max(2) }).superRefine((b, ctx) => {
	if (b.payments.length === 2) {
		const [a, c] = b.payments;
		if (a!.leaseId !== c!.leaseId)
			ctx.addIssue({ code: 'custom', path: ['payments'], message: 'Les deux encaissements visent le même bail.' });
		if (a!.purpose === c!.purpose || a!.purpose === 'expense' || c!.purpose === 'expense') {
			ctx.addIssue({ code: 'custom', path: ['payments'], message: 'Une saisie double réunit la caution et le loyer.' });
		}
	}
});
export type PaymentEntriesData = z.output<typeof paymentEntriesSchema>;

/** Validation unitaire ou groupée (espèces à valider, Mobile Money ou virement à rapprocher), en ligne. */
export const validatePaymentsSchema = z.object({
	paymentIds: z.array(idSchema).min(1, { error: 'Choisissez au moins un encaissement.' }).max(200, { error: '200 encaissements au plus.' })
});
export type ValidatePaymentsData = z.output<typeof validatePaymentsSchema>;

/** Annulation par contre-écriture, motif obligatoire (directeur, en ligne). */
export const cancelPaymentSchema = z.object({
	reason: z.string().trim().min(5, { error: 'Indiquez le motif (5 caractères au moins).' }).max(500, { error: 'Motif trop long.' })
});
export type CancelPaymentData = z.output<typeof cancelPaymentSchema>;

// ---------------------------------------------------------------- vues (API et appareil)

export interface PaymentView {
	id: string;
	kind: PaymentKind;
	reversesPaymentId: string | null;
	leaseId: string;
	tenantId: string;
	purpose: PaymentPurpose;
	depositAccountId: string | null;
	expenseId: string | null;
	amount: Fcfa;
	method: PaymentMeans;
	operator: MobileMoneyOperator | null;
	transactionReference: string | null;
	paidOn: string;
	status: PaymentStatus;
	provider: string;
	note: string | null;
	recordedBy: string | null;
	confirmedAt: string | null;
	confirmedBy: string | null;
	cancellationReason: string | null;
	cancelledAt: string | null;
	cancelledBy: string | null;
	createdAt: string;
}
