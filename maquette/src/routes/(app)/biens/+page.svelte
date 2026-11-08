<script lang="ts">
	import { Globe, MousePointerClick, Plus } from '@lucide/svelte';
	import PropertyList from '$lib/components/agency/PropertyList.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { demo } from '$lib/demo.svelte';
	import { device } from '$lib/device.svelte';
	import { formatFCFA } from '$lib/format';
	import { isListed } from '$lib/listing';
	import { summaryCounts, summaryOfUnit } from '$lib/unit-status';
	import UnitStatusBadge from '$lib/components/status/UnitStatusBadge.svelte';

	const counts = $derived(summaryCounts(demo.data, demo.data.units));
	/** Unités sans locataire en place : disponibles, à remettre en état, en travaux. */
	const freeUnits = $derived(
		demo.data.units
			.filter((u) => u.occupancy === 'free' || u.occupancy === 'notice')
			.map((u) => ({ unit: u, summary: summaryOfUnit(demo.data, u), property: demo.data.properties.find((p) => p.id === u.propertyId)! }))
	);
	const canCreate = $derived(demo.profileId !== 'field_agent');
	const title = $derived(demo.profileId === 'landlord' ? 'Mes logements' : demo.profileId === 'field_agent' ? 'Mes biens' : 'Biens');
</script>

<PageHeader {title} subtitle="{demo.data.properties.length} biens · {demo.data.units.length} unités">
	{#snippet actions()}
		{#if canCreate}
			<Button href="/biens/nouveau" data-testid="ajouter-bien"><Plus aria-hidden="true" /> {demo.profileId === 'landlord' ? 'Ajouter un logement' : 'Ajouter un bien'}</Button>
		{/if}
	{/snippet}
</PageHeader>

<main class="page pt-3 lg:grid lg:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)] lg:items-start lg:gap-6">
	<div class="space-y-3">
		<p class="text-base text-muted-foreground" data-testid="resume-parc">
			{counts.map((c) => `${c.count} ${c.label.toLowerCase()}`).join(' · ')}
		</p>
		<PropertyList />
	</div>

	<!-- Tablette et ordinateur : le panneau de droite résume le parc et propose les actions utiles. -->
	{#if device.twoPane}
	<section class="sticky top-20 space-y-4" aria-labelledby="titre-synthese">
		<div class="rounded-xl border bg-card p-5">
			<h2 id="titre-synthese" class="text-lg font-semibold">Synthèse du parc</h2>
			<dl class="mt-3 grid grid-cols-2 gap-3 xl:grid-cols-4">
				{#each counts as c (c.label)}
					<div class="rounded-lg bg-muted p-3">
						<dt><Badge variant={c.variant}>{c.label}</Badge></dt>
						<dd class="mt-1 text-2xl font-bold">{c.count}</dd>
					</div>
				{/each}
			</dl>
		</div>
		<div class="rounded-xl border bg-card">
			<h2 class="border-b px-5 py-3 text-lg font-semibold">Unités libres ou bientôt libres</h2>
			<ul class="divide-y">
				{#each freeUnits as f (f.unit.id)}
					{@const published = isListed(f.unit)}
					<li class="flex items-center gap-3 px-5 py-3">
						<div class="min-w-0 flex-1 space-y-1">
							<p class="truncate font-medium">{f.property.name} — {f.unit.label}</p>
							<p class="text-base text-muted-foreground">{f.unit.kind} · {formatFCFA(f.unit.rent)}/mois</p>
							<UnitStatusBadge summary={f.summary} />
						</div>
						{#if published}
							<Badge><Globe aria-hidden="true" /> Publiée</Badge>
						{:else}
							<Button variant="outline" href="/biens/{f.property.id}">Ouvrir</Button>
						{/if}
					</li>
				{:else}
					<li class="px-5 py-4 text-muted-foreground">Aucune unité libre.</li>
				{/each}
			</ul>
		</div>
		<p class="flex items-center gap-2 text-base text-muted-foreground">
			<MousePointerClick class="size-5" aria-hidden="true" /> Choisissez un bien dans la liste pour l’ouvrir ici.
		</p>
	</section>
	{/if}
</main>
