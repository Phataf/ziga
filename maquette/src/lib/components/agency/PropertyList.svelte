<script lang="ts">
	/**
	 * Liste des biens. Pleine page sur téléphone ; colonne de gauche d'une vue liste-détail
	 * sur tablette et ordinateur, avec le bien ouvert mis en évidence.
	 */
	import { ChevronRight, Globe, MapPin, Search } from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { demo } from '$lib/demo.svelte';
	import { isListed } from '$lib/listing';
	import { summaryCounts } from '$lib/unit-status';
	import { cn } from '$lib/utils';
	import { propertyUnits } from '$lib/views';

	let { activeId, testid = 'liste-biens' }: { activeId?: string; testid?: string } = $props();

	type Filter = 'all' | 'Ouagadougou' | 'Saaba';
	let filter = $state<Filter>('all');
	let query = $state('');

	const normalize = (s: string) =>
		s
			.toLowerCase()
			.normalize('NFD')
			.replace(/[̀-ͯ]/g, '');

	const properties = $derived(
		demo.data.properties.filter(
			(p) => (filter === 'all' || p.city === filter) && normalize(`${p.name} ${p.district}`).includes(normalize(query.trim()))
		)
	);
	const cities = $derived(new Set(demo.data.properties.map((p) => p.city)));

	const filters: { id: Filter; label: string }[] = [
		{ id: 'all', label: 'Tous' },
		{ id: 'Ouagadougou', label: 'Ouagadougou' },
		{ id: 'Saaba', label: 'Saaba' }
	];

	function summary(propertyId: string) {
		const units = propertyUnits(demo.data, propertyId);
		return {
			units,
			by: summaryCounts(demo.data, units),
			published: units.filter(isListed).length
		};
	}
</script>

<div class="space-y-3">
	<label class="relative hidden md:block">
		<span class="sr-only">Chercher un bien</span>
		<Search class="pointer-events-none absolute top-1/2 left-3 size-[18px] -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
		<input
			type="search"
			bind:value={query}
			placeholder="Nom ou quartier"
			class="min-h-11 w-full rounded-lg border-2 border-input bg-card pr-3 pl-9 outline-none focus-visible:border-ring"
		/>
	</label>

	{#if cities.size > 1}
		<div class="flex gap-2 overflow-x-auto" role="group" aria-label="Filtrer par commune">
			{#each filters as f (f.id)}
				<button
					type="button"
					class={cn(
						'min-h-11 rounded-full border-2 px-4 font-medium whitespace-nowrap',
						filter === f.id ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card hover:bg-accent'
					)}
					aria-pressed={filter === f.id}
					onclick={() => (filter = f.id)}
				>
					{f.label}
				</button>
			{/each}
		</div>
	{/if}

	<ul class="space-y-2" data-testid={testid}>
		{#each properties as p (p.id)}
			{@const s = summary(p.id)}
			{@const active = p.id === activeId}
			<li>
				<a
					href="/biens/{p.id}"
					aria-current={active ? 'page' : undefined}
					class={cn(
						'flex items-center gap-3 rounded-xl border bg-card p-3 hover:bg-accent',
						active && 'border-primary bg-secondary ring-1 ring-primary'
					)}
				>
					<div class="min-w-0 flex-1 space-y-1">
						<p class="truncate font-semibold">{p.name}</p>
						<p class="flex items-center gap-1 text-base text-muted-foreground">
							<MapPin class="size-4 shrink-0" aria-hidden="true" />
							<span class="truncate">{p.district}, {p.city} · {p.kind}</span>
						</p>
						<div class="flex flex-wrap gap-1">
							{#each s.by as c (c.label)}
								<Badge variant={c.variant}>{c.count} {c.label.toLowerCase()}</Badge>
							{/each}
							{#if s.published}
								<Badge variant="default"><Globe aria-hidden="true" /> publiée</Badge>
							{/if}
						</div>
					</div>
					<ChevronRight class="size-6 shrink-0 text-muted-foreground" aria-hidden="true" />
				</a>
			</li>
		{:else}
			<li class="rounded-xl border bg-card p-4 text-muted-foreground">Aucun bien ne correspond.</li>
		{/each}
	</ul>
</div>
