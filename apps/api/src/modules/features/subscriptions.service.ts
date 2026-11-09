/**
 * Palier de l'abonnement d'une organisation (lot 04), calculé à chaque lecture (jamais stocké) d'après les
 * abonnements saisis à la main et les durées réglables (SUBSCRIPTION_REMINDER_DAYS, SUBSCRIPTION_GRACE_DAYS).
 */
import { Inject, Injectable } from '@nestjs/common';
import { formatDate, toIsoDate } from '@ziga/shared/dates';
import { subscriptionStage, type SubscriptionState } from '@ziga/shared/subscriptions';
import { desc } from 'drizzle-orm';
import { AppError } from '../../common/app-error.js';
import { RequestContext } from '../../common/request-context.js';
import { APP_CONFIG } from '../../config/config.module.js';
import type { AppConfig } from '../../config/env.js';
import { DatabaseService } from '../../db/database.module.js';
import type { Tx } from '../../db/database.js';
import { subscriptions } from '../../db/schema/platform.js';

export type SubscriptionRecord = typeof subscriptions.$inferSelect;

@Injectable()
export class SubscriptionsService {
	constructor(
		private readonly database: DatabaseService,
		@Inject(APP_CONFIG) private readonly config: AppConfig
	) {}

	stage(
		planId: string,
		periods: readonly Pick<SubscriptionRecord, 'startsOn' | 'endsOn' | 'paymentStatus'>[],
		today = toIsoDate()
	): SubscriptionState {
		return subscriptionStage({
			planId,
			periods,
			today,
			reminderDays: this.config.SUBSCRIPTION_REMINDER_DAYS,
			graceDays: this.config.SUBSCRIPTION_GRACE_DAYS
		});
	}

	/** Abonnements de l'organisation, lus dans son contexte (RLS own_subscriptions, app_api en lecture seule). */
	async ofOrganization(organizationId: string, tx?: Tx): Promise<SubscriptionRecord[]> {
		const read = (t: Tx) => t.select().from(subscriptions).orderBy(desc(subscriptions.endsOn));
		const current = tx ?? RequestContext.get()?.tx;
		return current ? read(current) : this.database.withOrganization(organizationId, read);
	}

	async stateOf(organizationId: string, planId: string, tx?: Tx): Promise<{ state: SubscriptionState; periods: SubscriptionRecord[] }> {
		const periods = await this.ofOrganization(organizationId, tx);
		return { state: this.stage(planId, periods), periods };
	}

	/**
	 * Création permise ? Sinon 403 SUBSCRIPTION_EXPIRED (abonnement échu au-delà du délai de grâce). Partagé par la
	 * garde @Creation() et l'envoi des modifications (lot 05).
	 */
	async assertCreationAllowed(scope: { organizationId: string; planId: string }): Promise<void> {
		const { state } = await this.stateOf(scope.organizationId, scope.planId);
		if (state.stage === 'blocked') {
			throw new AppError(
				'SUBSCRIPTION_EXPIRED',
				`Abonnement échu${state.paidUntil ? ` depuis le ${formatDate(state.paidUntil)}` : ''} : les nouvelles créations sont suspendues. ` +
					'Les loyers, les reçus, les relevés, la sortie des locataires et l’export restent possibles. Contactez Ziga pour renouveler.',
				403,
				{ stage: state.stage, paidUntil: state.paidUntil, blockedFrom: state.blockedFrom }
			);
		}
	}
}
