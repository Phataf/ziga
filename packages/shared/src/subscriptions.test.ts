/** Paliers d'un abonnement échu (lot 04) : rappel 7 jours avant la fin, 15 jours de grâce, puis blocage des créations. */
import { describe, expect, it } from 'vitest';
import { addDays, daysBetween } from './dates.js';
import { creationsAllowed, subscriptionStage, type SubscriptionPeriod } from './subscriptions.js';

const base = { planId: 'essential', reminderDays: 7, graceDays: 15 };
const paid = (startsOn: string, endsOn: string): SubscriptionPeriod => ({ startsOn, endsOn, paymentStatus: 'paid' });

describe('paliers de l’abonnement', () => {
	it('Découverte : gratuite, jamais bloquée', () => {
		expect(subscriptionStage({ ...base, planId: 'discovery', periods: [], today: '2026-11-09' }).stage).toBe('free');
	});

	it('à jour, puis « échéance proche » dans les 7 derniers jours', () => {
		const periods = [paid('2026-11-01', '2026-11-30')];
		expect(subscriptionStage({ ...base, periods, today: '2026-11-22' }).stage).toBe('active');
		// 7 jours avant la fin (le 23 pour une fin le 30) : rappel.
		expect(subscriptionStage({ ...base, periods, today: '2026-11-23' }).stage).toBe('reminder');
		expect(subscriptionStage({ ...base, periods, today: '2026-11-30' }).stage).toBe('reminder');
	});

	it('échu : 15 jours de grâce, puis créations bloquées', () => {
		const periods = [paid('2026-10-01', '2026-10-31')];
		const grace = subscriptionStage({ ...base, periods, today: '2026-11-15' });
		expect(grace).toMatchObject({ stage: 'grace', paidUntil: '2026-10-31', blockedFrom: '2026-11-16' });
		expect(creationsAllowed(grace)).toBe(true);
		const blocked = subscriptionStage({ ...base, periods, today: '2026-11-16' });
		expect(blocked.stage).toBe('blocked');
		expect(creationsAllowed(blocked)).toBe(false);
	});

	it('périodes payées qui se suivent : couvertes jusqu’à la fin de la dernière', () => {
		const periods = [paid('2026-10-01', '2026-10-31'), paid('2026-11-01', '2026-11-30')];
		expect(subscriptionStage({ ...base, periods, today: '2026-10-28' })).toMatchObject({ stage: 'active', paidUntil: '2026-11-30' });
	});

	it('abonnement saisi mais pas encore payé : délai de grâce depuis son début, puis blocage', () => {
		const periods: SubscriptionPeriod[] = [{ startsOn: '2026-11-01', endsOn: '2026-11-30', paymentStatus: 'pending' }];
		expect(subscriptionStage({ ...base, periods, today: '2026-11-10' }).stage).toBe('grace');
		expect(subscriptionStage({ ...base, periods, today: '2026-11-16' }).stage).toBe('blocked');
	});

	it('offert : compte comme payé ; formule payante sans aucun abonnement : bloquée', () => {
		expect(
			subscriptionStage({
				...base,
				periods: [{ startsOn: '2026-11-01', endsOn: '2026-12-31', paymentStatus: 'waived' }],
				today: '2026-11-09'
			}).stage
		).toBe('active');
		expect(subscriptionStage({ ...base, periods: [], today: '2026-11-09' }).stage).toBe('blocked');
	});

	it('durées réglables', () => {
		const periods = [paid('2026-10-01', '2026-10-31')];
		expect(subscriptionStage({ ...base, graceDays: 0, periods, today: '2026-11-01' }).stage).toBe('blocked');
		expect(subscriptionStage({ ...base, reminderDays: 0, periods: [paid('2026-11-01', '2026-11-30')], today: '2026-11-29' }).stage).toBe(
			'active'
		);
		expect(subscriptionStage({ ...base, reminderDays: 0, periods: [paid('2026-11-01', '2026-11-30')], today: '2026-11-30' }).stage).toBe(
			'reminder'
		);
	});

	it('calcul des dates', () => {
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
		expect(daysBetween('2026-11-09', '2026-11-30')).toBe(21);
	});
});
