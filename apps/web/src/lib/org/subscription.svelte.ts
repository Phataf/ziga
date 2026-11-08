/** Abonnement de l'organisation active (lot 04), lu une fois par organisation pour le bandeau et les paramètres. */
import { NetworkError } from '../auth/http';
import { organizations } from './organizations.svelte';

export interface SubscriptionView {
	planId: string;
	planLabel: string;
	stage: 'free' | 'active' | 'reminder' | 'grace' | 'blocked';
	paidUntil: string | null;
	blockedFrom: string | null;
	periods: {
		id: string;
		planId: string;
		startsOn: string;
		endsOn: string;
		amount: number;
		paymentStatus: 'pending' | 'paid' | 'waived';
		paidOn: string | null;
	}[];
}

class Subscription {
	state = $state<SubscriptionView | null>(null);
	#for: string | null = null;

	async load(force = false): Promise<void> {
		const organizationId = organizations.activeId;
		if (!organizationId || (!force && this.#for === organizationId && this.state)) return;
		try {
			this.state = await organizations.call<SubscriptionView>('GET', '/organization/subscription');
			this.#for = organizationId;
		} catch (error) {
			if (!(error instanceof NetworkError)) this.state = null;
		}
	}
}

export const subscription = new Subscription();
