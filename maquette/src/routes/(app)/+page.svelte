<script lang="ts">
	import { CalendarClock, ChevronRight, CircleAlert, Wallet } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { demo } from '$lib/demo.svelte';
	import { formatDate, formatFCFA, formatMonth } from '$lib/format';
	import { monthStats } from '$lib/views';

	const stats = $derived(monthStats(demo.data));
	const ratio = $derived(stats.expected ? Math.min(100, Math.round((stats.collected / stats.expected) * 100)) : 0);
</script>

<header class="bg-primary px-4 pt-5 pb-16 text-primary-foreground">
	<div class="mx-auto max-w-lg">
		<p class="text-base opacity-90">Aujourd’hui, {formatDate(demo.today)}</p>
		<h1 class="text-2xl font-bold">{demo.data.agency.name}</h1>
	</div>
</header>

<main class="mx-auto -mt-12 max-w-lg space-y-4 px-4">
	<Card.Root data-testid="carte-loyers">
		<Card.Content class="space-y-3">
			<p class="text-base font-medium text-muted-foreground">Loyers de {formatMonth(stats.period)}</p>
			<div>
				<p class="text-base text-muted-foreground">Encaissés</p>
				<p class="text-3xl font-bold text-primary" data-testid="encaisse-mois">{formatFCFA(stats.collected)}</p>
				<p class="text-base text-muted-foreground">
					sur <span class="font-semibold text-foreground" data-testid="attendu-mois">{formatFCFA(stats.expected)}</span> attendus
				</p>
			</div>
			<div
				class="h-3 overflow-hidden rounded-full bg-muted"
				role="progressbar"
				aria-valuenow={ratio}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-label="Part des loyers encaissés"
			>
				<div class="h-full rounded-full bg-primary transition-all" style:width="{ratio}%"></div>
			</div>
			<p class="text-base text-muted-foreground">{ratio} % du mois encaissé</p>
		</Card.Content>
	</Card.Root>

	<Button href="/encaisser" size="lg" class="w-full text-xl">
		<Wallet class="size-6" aria-hidden="true" />
		Encaisser un loyer
	</Button>

	<a href="/impayes" class="block" data-testid="carte-impayes">
		<Card.Root class="border-destructive/30 bg-danger-soft">
			<Card.Content class="flex items-center gap-3">
				<CircleAlert class="size-8 shrink-0 text-destructive" aria-hidden="true" />
				<div class="flex-1">
					<p class="text-lg font-semibold text-destructive">
						{stats.arrearsCount} impayé{stats.arrearsCount > 1 ? 's' : ''}
					</p>
					<p class="text-base">{formatFCFA(stats.arrearsAmount)} en retard</p>
				</div>
				<span class="flex items-center text-base font-medium text-destructive">
					Voir <ChevronRight class="size-5" aria-hidden="true" />
				</span>
			</Card.Content>
		</Card.Root>
	</a>

	<section aria-labelledby="titre-jour" class="space-y-2">
		<h2 id="titre-jour" class="flex items-center gap-2 text-lg font-semibold">
			<CalendarClock class="size-5" aria-hidden="true" /> Échéances du jour
		</h2>
		{#if stats.dueToday.length === 0}
			<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground">Aucune échéance aujourd’hui.</p>
		{:else}
			<ul class="space-y-2" data-testid="echeances-du-jour">
				{#each stats.dueToday as v (v.lease.id)}
					<li>
						<a
							href="/encaisser/{v.lease.id}"
							class="flex min-h-16 items-center gap-3 rounded-xl border bg-card p-3 hover:bg-accent"
						>
							<div class="min-w-0 flex-1">
								<p class="truncate font-semibold">{v.tenant.civility} {v.tenant.name}</p>
								<p class="truncate text-base text-muted-foreground">{v.property.name} — {v.unit.label}</p>
							</div>
							<div class="text-right">
								<p class="font-semibold">{formatFCFA(v.balanceDue)}</p>
								<p class="text-base text-primary">Encaisser</p>
							</div>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</main>
