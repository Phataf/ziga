<script lang="ts">
	import { MapPin } from '@lucide/svelte';
	import PhotoPlaceholder from '$lib/components/PhotoPlaceholder.svelte';
	import { demo } from '$lib/demo.svelte';
	import { formatFCFA } from '$lib/format';
	import { listings } from '$lib/listing';

	const items = $derived(listings(demo.data));
</script>

<svelte:head><title>{demo.data.agency.name} — logements disponibles</title></svelte:head>

<header class="mx-auto max-w-lg px-4 pt-4 pb-2">
	<p class="text-base text-muted-foreground">Vitrine</p>
	<h1 class="text-2xl font-bold">{demo.data.agency.name}</h1>
	<p class="text-base text-muted-foreground">
		{items.length} logement{items.length > 1 ? 's' : ''} disponible{items.length > 1 ? 's' : ''} · Ouagadougou et Saaba
	</p>
</header>

<main class="mx-auto max-w-lg space-y-3 px-4 pb-8">
	{#each items as it (it.unit.id)}
		<a href="/annonce/{it.unit.id}" class="block overflow-hidden rounded-xl border bg-card hover:shadow-md" data-testid="annonce-carte">
			<div class="aspect-[400/220] overflow-hidden"><PhotoPlaceholder index={0} total={it.unit.photos} /></div>
			<div class="space-y-1 p-3">
				<p class="text-xl font-bold">{formatFCFA(it.unit.rent)} <span class="text-base font-normal text-muted-foreground">/ mois</span></p>
				<p class="font-semibold">{it.title}</p>
				<p class="flex items-center gap-1 text-base text-muted-foreground">
					<MapPin class="size-4" aria-hidden="true" /> {it.property.district}, {it.property.city}
				</p>
			</div>
		</a>
	{:else}
		<p class="rounded-xl border p-4 text-muted-foreground">Aucun logement disponible pour le moment.</p>
	{/each}
</main>
