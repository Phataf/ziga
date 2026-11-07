<script lang="ts">
	import { Globe, MousePointerClick } from '@lucide/svelte';
	import PropertyList from '$lib/components/agency/PropertyList.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { demo } from '$lib/demo.svelte';
	import { device } from '$lib/device.svelte';
	import { formatFCFA } from '$lib/format';
	import { unitStatusLabel, unitStatusVariant } from '$lib/labels';
	import type { UnitStatus } from '$lib/types';

	const counts = $derived.by(() => {
		const c: Record<UnitStatus, number> = { free: 0, rented: 0, reserved: 0, unavailable: 0 };
		for (const u of demo.data.units) c[u.status]++;
		return c;
	});
	const freeUnits = $derived(
		demo.data.units
			.filter((u) => u.status === 'free')
			.map((u) => ({ unit: u, property: demo.data.properties.find((p) => p.id === u.propertyId)! }))
	);
	const title = $derived(demo.profileId === 'landlord' ? 'Mes logements' : demo.profileId === 'field_agent' ? 'Mes biens' : 'Biens');
</script>

<PageHeader {title} subtitle="{demo.data.properties.length} biens · {demo.data.units.length} unités" />

<main class="page pt-3 lg:grid lg:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)] lg:items-start lg:gap-6">
	<div class="space-y-3">
		<p class="text-base text-muted-foreground">
			{counts.rented} louées · {counts.free} libres · {counts.reserved} réservées
		</p>
		<PropertyList />
	</div>

	<!-- Tablette et ordinateur : le panneau de droite résume le parc et propose les actions utiles. -->
	{#if device.twoPane}
	<section class="sticky top-20 space-y-4" aria-labelledby="titre-synthese">
		<div class="rounded-xl border bg-card p-5">
			<h2 id="titre-synthese" class="text-lg font-semibold">Synthèse du parc</h2>
			<dl class="mt-3 grid grid-cols-2 gap-3 xl:grid-cols-4">
				{#each Object.entries(counts) as [status, n] (status)}
					<div class="rounded-lg bg-muted p-3">
						<dt><Badge variant={unitStatusVariant[status as UnitStatus]}>{unitStatusLabel[status as UnitStatus]}</Badge></dt>
						<dd class="mt-1 text-2xl font-bold">{n}</dd>
					</div>
				{/each}
			</dl>
		</div>
		<div class="rounded-xl border bg-card">
			<h2 class="border-b px-5 py-3 text-lg font-semibold">Unités libres</h2>
			<ul class="divide-y">
				{#each freeUnits as f (f.unit.id)}
					{@const published = f.unit.visibility === 'published'}
					<li class="flex items-center gap-3 px-5 py-3">
						<div class="min-w-0 flex-1">
							<p class="truncate font-medium">{f.property.name} — {f.unit.label}</p>
							<p class="text-base text-muted-foreground">{f.unit.kind} · {formatFCFA(f.unit.rent)}/mois</p>
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
