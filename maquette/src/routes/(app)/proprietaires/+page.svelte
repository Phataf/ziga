<script lang="ts">
	import { ChevronRight } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { demo } from '$lib/demo.svelte';
	import { formatPhone } from '$lib/format';

	const rows = $derived(
		demo.data.owners.map((o) => {
			const props = demo.data.properties.filter((p) => p.ownerId === o.id);
			const ids = new Set(props.map((p) => p.id));
			return { owner: o, properties: props.length, units: demo.data.units.filter((u) => ids.has(u.propertyId)).length };
		})
	);
</script>

<PageHeader title="Propriétaires" subtitle="{rows.length} propriétaires, sans compte" back="/plus" backLabel="Plus" />

<main class="mx-auto max-w-lg px-4 pt-3">
	<ul class="divide-y rounded-xl border bg-card" data-testid="liste-proprietaires">
		{#each rows as r (r.owner.id)}
			<li>
				<a href="/proprietaires/{r.owner.id}/releve" class="flex min-h-16 items-center gap-3 p-3 hover:bg-accent">
					<div class="min-w-0 flex-1">
						<p class="truncate font-semibold">{r.owner.civility} {r.owner.name}</p>
						<p class="truncate text-base text-muted-foreground">
							{r.properties} bien{r.properties > 1 ? 's' : ''} · {r.units} unité{r.units > 1 ? 's' : ''} · {r.owner.residence}
						</p>
						<p class="text-base text-muted-foreground">{formatPhone(r.owner.phone)}</p>
					</div>
					<span class="flex items-center text-base text-primary">Relevé <ChevronRight class="size-5" aria-hidden="true" /></span>
				</a>
			</li>
		{/each}
	</ul>
</main>
