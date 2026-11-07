<script lang="ts">
	import { ChevronRight, CircleAlert, Wallet } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { demo } from '$lib/demo.svelte';
	import { formatDate, formatFCFA, formatMonthTitle } from '$lib/format';
	import { methodLabel, paymentStatusLabel, paymentStatusVariant } from '$lib/labels';
	import { leaseView, monthStats, paymentsOfMonth } from '$lib/views';

	const stats = $derived(monthStats(demo.data));
	const payments = $derived(paymentsOfMonth(demo.data));
	const toReconcile = $derived(payments.filter((p) => p.status === 'to_reconcile').length);
</script>

<PageHeader title="Encaissements" subtitle={formatMonthTitle(stats.period)} />

<main class="mx-auto max-w-lg space-y-4 px-4 pt-3">
	<Button href="/encaisser" size="lg" class="w-full text-xl">
		<Wallet class="size-6" aria-hidden="true" /> Encaisser un loyer
	</Button>

	<a href="/impayes" class="block">
		<Card.Root class="border-destructive/30 bg-danger-soft">
			<Card.Content class="flex items-center gap-3">
				<CircleAlert class="size-7 shrink-0 text-destructive" aria-hidden="true" />
				<div class="flex-1">
					<p class="font-semibold text-destructive">Impayés : {stats.arrearsCount}</p>
					<p class="text-base">{formatFCFA(stats.arrearsAmount)} en retard</p>
				</div>
				<ChevronRight class="size-6 text-destructive" aria-hidden="true" />
			</Card.Content>
		</Card.Root>
	</a>

	<div class="grid grid-cols-2 gap-2">
		<Card.Root>
			<Card.Content class="p-3">
				<p class="text-base text-muted-foreground">Encaissé ce mois</p>
				<p class="text-lg font-bold">{formatFCFA(stats.collected)}</p>
			</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Content class="p-3">
				<p class="text-base text-muted-foreground">À rapprocher</p>
				<p class="text-lg font-bold">{toReconcile} paiement{toReconcile > 1 ? 's' : ''}</p>
			</Card.Content>
		</Card.Root>
	</div>

	<section class="space-y-2" aria-labelledby="titre-liste">
		<h2 id="titre-liste" class="text-lg font-semibold">Derniers encaissements</h2>
		<ul class="divide-y rounded-xl border bg-card" data-testid="liste-encaissements">
			{#each payments as p (p.id)}
				{@const v = leaseView(demo.data, p.leaseId)!}
				<li>
					<a href="/recus/{p.id}" class="flex min-h-16 items-center gap-3 p-3 hover:bg-accent">
						<div class="min-w-0 flex-1">
							<p class="truncate font-semibold">{v.tenant.civility} {v.tenant.name}</p>
							<p class="truncate text-base text-muted-foreground">
								{formatDate(p.date)} · {methodLabel[p.method]}
							</p>
						</div>
						<div class="flex shrink-0 flex-col items-end gap-1">
							<span class="font-semibold">{formatFCFA(p.amount)}</span>
							<Badge variant={paymentStatusVariant[p.status]}>{paymentStatusLabel[p.status]}</Badge>
						</div>
					</a>
				</li>
			{:else}
				<li class="p-4 text-muted-foreground">Aucun encaissement ce mois-ci.</li>
			{/each}
		</ul>
	</section>
</main>
