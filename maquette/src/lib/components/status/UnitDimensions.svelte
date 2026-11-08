<script lang="ts">
	/** Fiche unité : une pastille par dimension du statut (D14), chacune nommée. */
	import { Badge } from '$lib/components/ui/badge';
	import type { Unit } from '$lib/types';
	import {
		dimensionsOf,
		listingLabel,
		listingStateOf,
		occupancyLabel,
		occupancyVariant,
		recordLabel,
		technicalLabel,
		technicalVariant
	} from '$lib/unit-status';

	let { unit, compact = false }: { unit: Unit; compact?: boolean } = $props();
	const d = $derived(dimensionsOf(unit));
	const listing = $derived(listingStateOf(unit));
	const dims = $derived([
		{ name: 'Fiche', value: recordLabel[d.record], variant: d.record === 'active' ? 'secondary' : 'outline', hint: 'saisie' },
		{ name: 'Occupation', value: occupancyLabel[d.occupancy], variant: occupancyVariant[d.occupancy], hint: 'calculée à partir des baux' },
		{ name: 'État technique', value: technicalLabel[d.technical], variant: technicalVariant[d.technical], hint: 'saisi' },
		{ name: 'Annonce', value: listingLabel[listing], variant: listing === 'published' ? 'default' : 'outline', hint: 'suit la disponibilité' }
	] as const);
</script>

{#if compact}
	<p class="text-base text-muted-foreground" data-testid="dimensions-{unit.id}">
		{occupancyLabel[d.occupancy]} · {technicalLabel[d.technical]} · {listingLabel[listing]}
	</p>
{:else}
	<dl class="grid grid-cols-2 gap-2 xl:grid-cols-4" data-testid="dimensions-{unit.id}">
		{#each dims as x (x.name)}
			<div class="space-y-1 rounded-lg border bg-card p-3">
				<dt class="text-base text-muted-foreground">{x.name}</dt>
				<dd><Badge variant={x.variant}>{x.value}</Badge></dd>
				<dd class="text-sm text-muted-foreground">{x.hint}</dd>
			</div>
		{/each}
	</dl>
{/if}
