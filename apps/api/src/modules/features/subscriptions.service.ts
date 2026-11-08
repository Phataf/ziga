/**
 * Palier de l'abonnement d'une organisation (lot 04), calculé à chaque lecture (jamais stocké) d'après les
 * abonnements saisis à la main et les durées réglables (SUBSCRIPTION_REMINDER_DAYS, SUBSCRIPTION_GRACE_DAYS).
 */
import { Inject, Injectable } from '@nestjs/common';
import { toIsoDate } from '@ziga/shared/dates';
import { subscriptionStage, type SubscriptionState } from '@ziga/shared/subscriptions';
import { desc } from 'drizzle-orm';
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
}
