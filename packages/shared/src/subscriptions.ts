/**
 * Abonnements des organisations à la plateforme (lot 04) : saisis à la main, encaissés sur le compte de la plateforme
 * (ce ne sont jamais des loyers, CLAUDE.md règle 5). Paliers d'un abonnement échu, calculés, jamais stockés :
 * rappel N jours avant la fin, puis délai de grâce, puis blocage des seules créations. Durées réglables
 * (variables d'environnement SUBSCRIPTION_REMINDER_DAYS et SUBSCRIPTION_GRACE_DAYS), passées en paramètres.
 */
import { addDays, daysBetween } from './dates.js';

export const SUBSCRIPTION_PAYMENT_STATUSES = ['pending', 'paid', 'waived'] as const;
export type SubscriptionPaymentStatus = (typeof SUBSCRIPTION_PAYMENT_STATUSES)[number];
export const SUBSCRIPTION_PAYMENT_LABELS: Record<SubscriptionPaymentStatus, string> = {
	pending: 'À payer',
	paid: 'Payé',
	waived: 'Offert'
};

export interface SubscriptionPeriod {
	startsOn: string;
	endsOn: string;
	paymentStatus: SubscriptionPaymentStatus;
}

export type SubscriptionStage = 'free' | 'active' | 'reminder' | 'grace' | 'blocked';
export const SUBSCRIPTION_STAGE_LABELS: Record<SubscriptionStage, string> = {
	free: 'Gratuite',
	active: 'À jour',
	reminder: 'Échéance proche',
	grace: 'Échu, délai de grâce',
	blocked: 'Échu, créations bloquées'
};

export interface SubscriptionState {
	stage: SubscriptionStage;
	/** Dernier jour couvert par un abonnement payé (ou la veille du premier abonnement à payer). */
	paidUntil: string | null;
	/** Premier jour où les créations sont bloquées (si échu). */
	blockedFrom: string | null;
}

export interface StageOptions {
	planId: string;
	periods: readonly SubscriptionPeriod[];
	/** Date du jour (aaaa-mm-jj, heure de Ouagadougou). */
	today: string;
	reminderDays: number;
	graceDays: number;
}

/**
 * Palier de l'abonnement. Découverte : gratuite, jamais bloquée. Sinon :
 * - une période payée (ou offerte) couvre aujourd'hui → à jour, ou « échéance proche » dans les N derniers jours ;
 * - sinon, la dernière couverture est passée (ou un abonnement attend son paiement) → délai de grâce, puis blocage.
 * Sans aucune période (formule payante sans abonnement saisi) : créations bloquées.
 */
export function subscriptionStage(o: StageOptions): SubscriptionState {
	if (o.planId === 'discovery') return { stage: 'free', paidUntil: null, blockedFrom: null };
	const covered = o.periods.filter((p) => p.paymentStatus !== 'pending');
	const current = covered.find((p) => p.startsOn <= o.today && o.today <= p.endsOn);
	const lastPaid =
		covered
			.map((p) => p.endsOn)
			.sort()
			.at(-1) ?? null;
	if (current) {
		// Périodes payées qui se suivent : on va jusqu'à la fin de la dernière.
		const paidUntil = lastPaid!;
		const left = daysBetween(o.today, paidUntil);
		return { stage: left <= o.reminderDays ? 'reminder' : 'active', paidUntil, blockedFrom: null };
	}
	const firstPending = o.periods
		.filter((p) => p.paymentStatus === 'pending')
		.map((p) => p.startsOn)
		.sort()[0];
	const due = lastPaid && lastPaid < o.today ? lastPaid : firstPending ? addDays(firstPending, -1) : lastPaid;
	if (!due) return { stage: 'blocked', paidUntil: null, blockedFrom: o.today };
	const blockedFrom = addDays(due, o.graceDays + 1);
	return { stage: o.today < blockedFrom ? 'grace' : 'blocked', paidUntil: due, blockedFrom };
}

/** Les créations (biens, unités, baux, propriétaires, membres, publications) sont-elles permises ? */
export function creationsAllowed(state: SubscriptionState): boolean {
	return state.stage !== 'blocked';
}
