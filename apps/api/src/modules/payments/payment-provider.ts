/**
 * Adaptateur de paiement (D03, lot 09) : chaque prestataire est derrière la même interface, dans un registre. Le
 * registre n'a au lot 09 que `manual` (le registre des encaissements saisis à la main) ; les agrégateurs Mobile Money
 * (lot 14) s'y ajouteront sans toucher au reste. Spécification : docs/PAIEMENTS.md.
 *
 * Règles (CLAUDE.md §5) :
 * - la plateforme ne détient jamais les fonds (règle 5) : un agrégateur encaisse sur le compte marchand de
 *   l'organisation, avec ses identifiants à elle ;
 * - un paiement n'est « confirmé » que sur preuve (règle 6) : jamais sur la seule redirection du client, seulement sur
 *   une notification signée (`handleWebhook`) ou une vérification auprès du prestataire (`verify`) ;
 * - le statut suit la machine d'états de packages/shared (payments.ts), et la base la vérifie.
 */
import { Injectable } from '@nestjs/common';
import {
	initialPaymentStatus,
	MANUAL_PROVIDER,
	type MobileMoneyOperator,
	type PaymentMeans,
	type PaymentStatus
} from '@ziga/shared/payments';
import type { OrganizationRole } from '@ziga/shared/permissions';
import { AppError } from '../../common/app-error.js';

export interface InitiatePaymentInput {
	organizationId: string;
	paymentId: string;
	amount: number;
	method: PaymentMeans;
	operator: MobileMoneyOperator | null;
	/** Rôle de la personne qui saisit (registre) ou qui lance le paiement (paiement direct). */
	role: OrganizationRole;
	/** Numéro du payeur, pour un paiement direct (lot 14). */
	payerPhone?: string | null;
}

export interface InitiatePaymentResult {
	/** Statut de départ, décidé par le prestataire et jamais par l'appareil. */
	status: PaymentStatus;
	providerReference: string | null;
	/** Lot 14 : adresse vers laquelle le payeur est envoyé, s'il y en a une. */
	redirectUrl?: string | null;
}

export interface VerifyPaymentResult {
	status: PaymentStatus;
	providerReference: string | null;
}

/** Notification d'un prestataire, signature vérifiée par l'adaptateur avant toute lecture. */
export interface WebhookEvent {
	paymentId: string;
	status: PaymentStatus;
	providerReference: string;
}

export interface PaymentProvider {
	/** `manual`, ou la clé de l'agrégateur (lot 14). */
	readonly key: string;
	/** Démarre un encaissement : statut de départ et référence du prestataire. */
	initiate(input: InitiatePaymentInput): Promise<InitiatePaymentResult>;
	/** Interroge le prestataire sur un encaissement en cours ; seule voie, avec la notification, vers `confirmed`. */
	verify(payment: { id: string; providerReference: string | null; status: PaymentStatus }): Promise<VerifyPaymentResult>;
	/** Notification signée du prestataire ; une signature invalide est refusée sans rien lire. */
	handleWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): Promise<WebhookEvent>;
	/** Remboursement, si le prestataire le permet (hors périmètre du lot 09). */
	refund?(payment: { id: string; providerReference: string | null; amount: number }): Promise<{ providerReference: string }>;
}

/**
 * Registre des encaissements saisis à la main (espèces, Mobile Money saisi avec sa référence, virement) : le statut
 * de départ suit la règle 6 (initialPaymentStatus) ; la preuve est la validation par une personne habilitée
 * (`payment.validate`), jamais une vérification automatique.
 */
export class ManualPaymentProvider implements PaymentProvider {
	readonly key = MANUAL_PROVIDER;

	async initiate(input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
		if (input.method === 'mobile_money_direct') {
			throw new AppError('PAYMENT_METHOD_UNAVAILABLE', 'Le paiement Mobile Money depuis la plateforme arrive plus tard.', 409);
		}
		return { status: initialPaymentStatus(input.method, input.role), providerReference: null };
	}

	/** Rien à interroger : un encaissement saisi à la main est confirmé par une personne, pas par un prestataire. */
	async verify(payment: { status: PaymentStatus; providerReference: string | null }): Promise<VerifyPaymentResult> {
		return { status: payment.status, providerReference: payment.providerReference };
	}

	async handleWebhook(): Promise<WebhookEvent> {
		throw new AppError('WEBHOOK_UNSUPPORTED', 'Le registre manuel ne reçoit aucune notification.', 404);
	}
}

@Injectable()
export class PaymentProviders {
	readonly #providers = new Map<string, PaymentProvider>();

	constructor() {
		this.register(new ManualPaymentProvider());
	}

	register(provider: PaymentProvider): void {
		if (this.#providers.has(provider.key)) throw new Error(`Prestataire déjà inscrit : ${provider.key}`);
		this.#providers.set(provider.key, provider);
	}

	get(key: string): PaymentProvider {
		const provider = this.#providers.get(key);
		if (!provider) throw new AppError('PAYMENT_PROVIDER_UNKNOWN', `Prestataire de paiement inconnu : ${key}.`, 404);
		return provider;
	}

	keys(): string[] {
		return [...this.#providers.keys()].sort();
	}
}
