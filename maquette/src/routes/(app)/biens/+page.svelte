<script lang="ts">
	import { ChevronRight, Globe, MapPin } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { demo } from '$lib/demo.svelte';
	import { unitStatusLabel, unitStatusVariant } from '$lib/labels';
	import type { UnitStatus } from '$lib/types';
	import { cn } from '$lib/utils';
	import { propertyUnits } from '$lib/views';

	type Filter = 'all' | 'Ouagadougou' | 'Saaba';
	let filter = $state<Filter>('all');

	const properties = $derived(
		demo.data.properties.filter((p) => filter === 'all' || p.city === filter)
	);
	const counts = $derived.by(() => {
		const c: Record<UnitStatus, number> = { free: 0, rented: 0, reserved: 0, unavailable: 0 };
		for (const u of demo.data.units) c[u.status]++;
		return c;
	});

	const filters: { id: Filter; label: string }[] = [
		{ id: 'all', label: 'Tous' },
		{ id: 'Ouagadougou', label: 'Ouagadougou' },
		{ id: 'Saaba', label: 'Saaba' }
	];

	function summary(propertyId: string) {
		const units = propertyUnits(demo.data, propertyId);
		const by = new Map<UnitStatus, number>();
		for (const u of units) by.set(u.status, (by.get(u.status) ?? 0) + 1);
		return {
			units,
			by: [...by.entries()],
			published: units.filter((u) => u.visibility === 'published' && u.status === 'free').length
		};
	}
</script>

<PageHeader
	title="Biens"
	subtitle="{demo.data.properties.length} biens · {demo.data.units.length} unités"
/>

<main class="mx-auto max-w-lg space-y-3 px-4 pt-3">
	<p class="text-base text-muted-foreground">
		{counts.rented} louées · {counts.free} libres · {counts.reserved} réservées
	</p>

	<div class="flex gap-2 overflow-x-auto" role="group" aria-label="Filtrer par commune">
		{#each filters as f (f.id)}
			<button
				type="button"
				class={cn(
					'min-h-11 rounded-full border-2 px-4 font-medium whitespace-nowrap',
					filter === f.id ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card'
				)}
				aria-pressed={filter === f.id}
				onclick={() => (filter = f.id)}
			>
				{f.label}
			</button>
		{/each}
	</div>

	<ul class="space-y-2" data-testid="liste-biens">
		{#each properties as p (p.id)}
			{@const s = summary(p.id)}
			<li>
				<a href="/biens/{p.id}" class="flex items-center gap-3 rounded-xl border bg-card p-3 hover:bg-accent">
					<div class="min-w-0 flex-1 space-y-1">
						<p class="truncate font-semibold">{p.name}</p>
						<p class="flex items-center gap-1 text-base text-muted-foreground">
							<MapPin class="size-4 shrink-0" aria-hidden="true" />
							<span class="truncate">{p.district}, {p.city} · {p.kind}</span>
						</p>
						<div class="flex flex-wrap gap-1">
							{#each s.by as [status, n] (status)}
								<Badge variant={unitStatusVariant[status]}>{n} {unitStatusLabel[status].toLowerCase()}{n > 1 ? 's' : ''}</Badge>
							{/each}
							{#if s.published}
								<Badge variant="default"><Globe aria-hidden="true" /> publiée</Badge>
							{/if}
						</div>
					</div>
					<ChevronRight class="size-6 shrink-0 text-muted-foreground" aria-hidden="true" />
				</a>
			</li>
		{/each}
	</ul>
</main>
