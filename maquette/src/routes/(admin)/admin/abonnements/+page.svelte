<script lang="ts">
	/**
	 * Formules et abonnements. Au lancement, l'administrateur saisit les paiements à la main.
	 * Les abonnements sont encaissés sur le compte de la plateforme : ce ne sont jamais des loyers (règle 5).
	 */
	import { CircleCheck, Info } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { demo } from '$lib/demo.svelte';
	import { device } from '$lib/device.svelte';
	import { formatDate, formatFCFA } from '$lib/format';
	import { plans, platformOrganizations, subscriptionLabel } from '$lib/platform';

	const rows = $derived(
		platformOrganizations.map((o) => {
			const plan = plans.find((p) => p.id === o.plan)!;
			const paidNow = demo.log.subscriptionPayments[o.id];
			const status = paidNow ? 'up_to_date' : o.subscription.status;
			return { o, plan, paidNow, status, units: demo.orgs[o.id]?.units.length ?? 0 };
		})
	);
</script>

<PageHeader title="Formules et abonnements" subtitle="Prix du cadrage, à confirmer en entretien" />

<main class="page space-y-5 pt-3" data-testid="admin-abonnements">
	<section class="grid grid-cols-1 gap-3 md:grid-cols-3" aria-label="Formules">
		{#each plans as p (p.id)}
			<div class="space-y-1 rounded-xl border bg-card p-4">
				<p class="font-semibold">{p.label}</p>
				<p class="text-2xl font-bold tabular-nums">{p.monthly ? `${formatFCFA(p.monthly)} / mois` : 'Gratuite'}</p>
				<p class="text-base text-muted-foreground">{p.target} · jusqu’à {p.maxUnits} unités{p.yearly ? ` · ${formatFCFA(p.yearly)} par an` : ''}</p>
			</div>
		{/each}
	</section>

	<section class="space-y-2" aria-labelledby="titre-abonnements">
		<h2 id="titre-abonnements" class="text-lg font-semibold">Abonnements</h2>
		<ul class={device.isPhone ? 'space-y-2' : 'divide-y rounded-xl border bg-card'}>
			{#each rows as r (r.o.id)}
				<li class="flex flex-wrap items-center gap-3 {device.isPhone ? 'rounded-xl border bg-card p-4' : 'px-4 py-3'}" data-testid="abonnement-{r.o.id}">
					<div class="min-w-0 flex-1">
						<p class="font-semibold">{r.o.name}</p>
						<p class="text-base text-muted-foreground">
							{r.plan.label} · {r.units} / {r.plan.maxUnits} unités{r.o.subscription.paidUntil ? ` · payé jusqu’au ${formatDate(r.o.subscription.paidUntil)}` : ''}
						</p>
					</div>
					<Badge variant={r.status === 'reminder' ? 'warning' : 'success'}>{subscriptionLabel[r.status]}</Badge>
					{#if r.paidNow}
						<span class="flex items-center gap-1 text-base text-primary" role="status"><CircleCheck class="size-4" aria-hidden="true" /> Paiement enregistré le {formatDate(r.paidNow)}</span>
					{:else if r.plan.monthly}
						<Button variant="outline" class="w-full whitespace-normal md:w-auto" onclick={() => demo.recordSubscriptionPayment(r.o.id, r.o.name, `${formatFCFA(r.plan.monthly)}, ${r.plan.label}`)}>Enregistrer un paiement de {formatFCFA(r.plan.monthly)}</Button>
					{/if}
				</li>
			{/each}
		</ul>
	</section>

	<p class="flex items-start gap-2 text-base text-muted-foreground">
		<Info class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
		Abonnement impayé : rappel, puis blocage des nouvelles créations. La consultation, les reçus et l’export restent possibles ; rien n’est supprimé.
	</p>
</main>
