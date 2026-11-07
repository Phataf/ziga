<script lang="ts">
	import { ArrowRight, Building2, FileText, TrendingUp } from '@lucide/svelte';
	import AgencyContact from '$lib/components/AgencyContact.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { demo, OWNER_PORTAL_ID } from '$lib/demo.svelte';
	import { formatFCFA, formatMonthTitle } from '$lib/format';
	import { unitStatusLabel, unitStatusVariant } from '$lib/labels';
	import { ownerStatement } from '$lib/views';

	function shift(period: string, delta: number) {
		const d = new Date(+period.slice(0, 4), +period.slice(5, 7) - 1 + delta, 1);
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
	}

	const current = $derived(demo.today.slice(0, 7));
	const previous = $derived(shift(current, -1));
	const last = $derived(ownerStatement(demo.data, OWNER_PORTAL_ID, previous)!);
	const now = $derived(ownerStatement(demo.data, OWNER_PORTAL_ID, current)!);
	const owner = $derived(last.owner);
	const rented = $derived(demo.data.units.filter((u) => u.status === 'rented').length);
</script>

<PageHeader title="Bonjour {owner.civility} {owner.name}" subtitle="Vos biens gérés par {demo.data.agency.name}" />

<main class="page space-y-4 pt-3 md:space-y-6" data-testid="espace-proprietaire">
	<section class="grid grid-cols-1 gap-3 md:grid-cols-3" aria-label="Vos revenus">
		<Card.Root class="border-primary/30 bg-success-soft md:col-span-1">
			<Card.Content class="space-y-1">
				<p class="text-base text-secondary-foreground">Net reversé — {formatMonthTitle(previous)}</p>
				<p class="text-3xl font-bold text-primary" data-testid="net-proprietaire">{formatFCFA(last.totals.net)}</p>
				<p class="text-base text-muted-foreground">après commission et dépenses</p>
			</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Content class="space-y-1">
				<p class="flex items-center gap-2 text-base text-muted-foreground"><TrendingUp class="size-[18px]" aria-hidden="true" /> {formatMonthTitle(current)}, en cours</p>
				<p class="text-2xl font-bold">{formatFCFA(now.totals.received)}</p>
				<p class="text-base text-muted-foreground">de loyers déjà encaissés</p>
			</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Content class="space-y-1">
				<p class="flex items-center gap-2 text-base text-muted-foreground"><Building2 class="size-[18px]" aria-hidden="true" /> Occupation</p>
				<p class="text-2xl font-bold">{rented} / {demo.data.units.length}</p>
				<p class="text-base text-muted-foreground">unités louées</p>
			</Card.Content>
		</Card.Root>
	</section>

	<div class="grid grid-cols-1 gap-4 md:gap-6 xl:grid-cols-3">
		<section class="space-y-3 xl:col-span-2" aria-labelledby="titre-mes-biens">
			<div class="flex items-center justify-between">
				<h2 id="titre-mes-biens" class="text-lg font-semibold">Mes biens</h2>
				<a href="/proprietaire/biens" class="flex items-center gap-1 text-base text-primary hover:underline">Détail <ArrowRight class="size-4" aria-hidden="true" /></a>
			</div>
			<ul class="grid grid-cols-1 gap-2 md:grid-cols-2">
				{#each demo.data.units as u (u.id)}
					{@const p = demo.data.properties.find((x) => x.id === u.propertyId)!}
					<li class="flex items-center justify-between gap-3 rounded-xl border bg-card p-3">
						<div class="min-w-0">
							<p class="truncate font-semibold">{p.name} — {u.label}</p>
							<p class="text-base text-muted-foreground">{formatFCFA(u.rent)}/mois</p>
						</div>
						<Badge variant={unitStatusVariant[u.status]}>{unitStatusLabel[u.status]}</Badge>
					</li>
				{/each}
			</ul>
			<Button variant="outline" href="/proprietaire/releves" class="w-full md:w-auto"><FileText aria-hidden="true" /> Voir mes relevés</Button>
		</section>
		<AgencyContact message="Bonjour {demo.data.agency.name}, c’est {owner.civility} {owner.name}." />
	</div>
</main>
