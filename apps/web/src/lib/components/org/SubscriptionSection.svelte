<script lang="ts">
	/** Abonnement de l'organisation (lot 04), en lecture : formule, palier, périodes saisies par Ziga. */
	import { onMount } from 'svelte';
	import { formatFcfa } from '@ziga/shared/money';
	import { formatDate } from '@ziga/shared/dates';
	import { SUBSCRIPTION_PAYMENT_LABELS } from '@ziga/shared/subscriptions';
	import { fr } from '#lib/i18n/fr.ts';
	import { subscription } from '#lib/org/subscription.svelte.ts';

	const t = fr.orgSettings;
	onMount(() => subscription.load());
	const s = $derived(subscription.state);
</script>

<section class="space-y-3 rounded-2xl border bg-card p-4 md:p-6" aria-labelledby="titre-abonnement" data-testid="abonnement-organisation">
	<h2 id="titre-abonnement" class="text-lg font-semibold">{t.subscription}</h2>
	{#if s}
		<p class="flex flex-wrap items-center gap-2 text-base">
			<span class="font-semibold">{t.plan(s.planLabel)}</span>
			<span class="rounded-full bg-secondary px-3 py-0.5 text-sm text-secondary-foreground">{fr.stages[s.stage]}</span>
		</p>
		{#if s.stage === 'free'}<p class="text-base text-muted-foreground">{t.free}</p>{/if}
		{#if s.paidUntil}<p class="text-base">{t.paidUntil(formatDate(s.paidUntil))}</p>{/if}
		{#if s.blockedFrom}<p class="text-base">{t.blockedFrom(formatDate(s.blockedFrom))}</p>{/if}
		{#if s.stage !== 'free'}
			<h3 class="pt-2 font-semibold">{t.periods}</h3>
			<ul class="divide-y rounded-xl border">
				{#each s.periods as p (p.id)}
					<li class="flex flex-wrap justify-between gap-2 p-3 text-base">
						<span>{formatDate(p.startsOn)} – {formatDate(p.endsOn)} · {fr.plans[p.planId] ?? p.planId}</span>
						<span class="tabular-nums">{formatFcfa(p.amount)} · {SUBSCRIPTION_PAYMENT_LABELS[p.paymentStatus]}</span>
					</li>
				{:else}
					<li class="p-3 text-base text-muted-foreground">{t.noPeriod}</li>
				{/each}
			</ul>
		{/if}
	{/if}
</section>
