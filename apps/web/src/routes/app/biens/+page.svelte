<script lang="ts">
	/**
	 * Biens et unités (lot 07) : lus dans la base de l'appareil, sans appel réseau, pour l'organisation active seulement.
	 * Filtres sur l'appareil : quartier, disponibilité, état technique, propriétaire. Une pastille de synthèse par unité
	 * (D14). Cartes sur téléphone et tablette, tableau sur ordinateur. L'agent de terrain ne reçoit que ses unités
	 * affectées (Sync Streams) : il voit « Mes biens ».
	 */
	import { onMount } from 'svelte';
	import { Building2, Plus } from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import { formatFcfa } from '@ziga/shared/money';
	import type { OwnerView } from '@ziga/shared/owners';
	import { can } from '@ziga/shared/permissions';
	import { TECHNICAL_STATUSES, type PropertyView, type UnitView } from '@ziga/shared/properties';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import StatusBadge from '#lib/components/properties/StatusBadge.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { toOwner } from '#lib/owners/views.ts';
	import { filterProperties, NO_FILTERS, toProperty, toUnit, unitSummary, type PropertyFilters } from '#lib/properties/views.ts';
	import { GEOGRAPHY_QUERIES, LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';

	const t = fr.properties;
	const role = $derived(organizations.active?.role);
	const landlord = $derived(organizations.active?.type === 'landlord');
	const agent = $derived(role === 'field_agent');
	const allowed = $derived(can(role, 'property.read'));
	const canCreate = $derived(can(role, 'property.manage'));
	const title = $derived(landlord ? t.titleLandlord : agent ? t.titleAgent : t.title);
	const select = 'min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 text-base';

	let properties = $state<PropertyView[]>([]);
	let units = $state<UnitView[]>([]);
	let owners = $state<OwnerView[]>([]);
	let neighborhoods = $state<Record<string, string>>({});
	let filters = $state<PropertyFilters>({ ...NO_FILTERS });
	let message = $state<string | null>(null);

	onMount(() => {
		if (!allowed) return;
		const id = organizations.activeId;
		const onError = (error: Error) => (message = messageOf(error));
		const stops = [
			sync.watch<Record<string, unknown>>(LOCAL_QUERIES.properties, [id], (rows) => (properties = rows.map(toProperty)), onError),
			sync.watch<Record<string, unknown>>(LOCAL_QUERIES.units, [id], (rows) => (units = rows.map(toUnit)), onError),
			sync.watch<Record<string, unknown>>(LOCAL_QUERIES.owners, [id], (rows) => (owners = rows.map(toOwner)), onError),
			sync.watch<Record<string, unknown>>(
				GEOGRAPHY_QUERIES.neighborhoods,
				[],
				(rows) => (neighborhoods = Object.fromEntries(rows.map((r) => [String(r.id), String(r.name)]))),
				onError
			)
		];
		return () => stops.forEach((stop) => stop());
	});

	const shown = $derived(filterProperties(properties, units, filters));
	const unitsOf = (p: PropertyView) => units.filter((u) => u.propertyId === p.id);
	const usedNeighborhoods = $derived([...new Set(properties.map((p) => p.neighborhoodId).filter((n): n is string => !!n))]);
	const ownerName = (id: string) => owners.find((o) => o.id === id)?.name ?? '';
	const rentRange = (list: UnitView[]) => {
		const rents = list.map((u) => u.rent).filter((r): r is number => r !== null);
		if (!rents.length) return '';
		const [min, max] = [Math.min(...rents), Math.max(...rents)];
		return min === max ? formatFcfa(min) : `${formatFcfa(min)} – ${formatFcfa(max)}`;
	};
</script>

<PageHeader {title} subtitle={agent ? t.agentNote : t.subtitle}>
	{#snippet actions()}
		{#if allowed && canCreate && !device.isPhone}
			<Button href={resolve('/app/biens/assistant')}><Plus aria-hidden="true" />{t.new}</Button>
		{/if}
	{/snippet}
</PageHeader>

<main class="page space-y-4 pt-3 pb-10" data-testid="biens">
	{#if !allowed}
		<FormAlert message={fr.app.notFound} />
	{:else}
		<FormAlert {message} />
		{#if canCreate && device.isPhone}
			<Button size="lg" class="w-full" href={resolve('/app/biens/assistant')}><Plus aria-hidden="true" />{t.new}</Button>
		{/if}

		{#if properties.length}
			<fieldset class="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="filtres">
				<legend class="px-1 font-semibold">{t.filters}</legend>
				<div class="space-y-1">
					<label for="filtre-quartier" class="block font-medium">{t.filterNeighborhood}</label>
					<select id="filtre-quartier" bind:value={filters.neighborhoodId} class={select}>
						<option value="">{t.all}</option>
						{#each usedNeighborhoods as n (n)}<option value={n}>{neighborhoods[n] ?? ''}</option>{/each}
					</select>
				</div>
				<div class="space-y-1">
					<label for="filtre-disponibilite" class="block font-medium">{t.filterAvailability}</label>
					<select id="filtre-disponibilite" bind:value={filters.availability} class={select}>
						<option value="all">{t.all}</option>
						<option value="available">{t.availableOnly}</option>
						<option value="unavailable">{t.unavailableOnly}</option>
					</select>
				</div>
				<div class="space-y-1">
					<label for="filtre-technique" class="block font-medium">{t.filterTechnical}</label>
					<select id="filtre-technique" bind:value={filters.technical} class={select}>
						<option value="all">{t.all}</option>
						{#each TECHNICAL_STATUSES as s (s)}<option value={s}>{t.technical[s]}</option>{/each}
					</select>
				</div>
				{#if !landlord && !agent}
					<div class="space-y-1">
						<label for="filtre-proprietaire" class="block font-medium">{t.filterOwner}</label>
						<select id="filtre-proprietaire" bind:value={filters.ownerId} class={select}>
							<option value="">{t.all}</option>
							{#each owners as o (o.id)}<option value={o.id}>{o.name}</option>{/each}
						</select>
					</div>
				{/if}
			</fieldset>
		{/if}

		{#if !properties.length}
			<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground">{agent ? t.emptyAgent : t.empty}</p>
		{:else if !shown.length}
			<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground">{t.noResult}</p>
		{:else if device.isDesktop}
			<div class="overflow-x-auto rounded-xl border bg-card">
				<table class="w-full text-left text-base">
					<thead class="border-b text-muted-foreground">
						<tr>
							<th class="px-4 py-3 font-medium">{t.name}</th>
							<th class="px-4 py-3 font-medium">{t.neighborhood}</th>
							{#if !landlord && !agent}<th class="px-4 py-3 font-medium">{t.owner}</th>{/if}
							<th class="px-4 py-3 font-medium">{t.units}</th>
							<th class="px-4 py-3 font-medium">{t.rent}</th>
						</tr>
					</thead>
					<tbody class="divide-y">
						{#each shown as p (p.id)}
							{@const list = unitsOf(p)}
							<tr data-testid="bien">
								<td class="px-4 py-3">
									<a class="font-medium underline-offset-2 hover:underline" href={resolve('/app/biens/[id]', { id: p.id })}>{p.name}</a>
									<span class="block text-sm text-muted-foreground">{t.types[p.type]} · {t.recordStatus[p.recordStatus]}</span>
								</td>
								<td class="px-4 py-3">{p.neighborhoodId ? (neighborhoods[p.neighborhoodId] ?? '') : ''}</td>
								{#if !landlord && !agent}<td class="px-4 py-3">{ownerName(p.ownerId)}</td>{/if}
								<td class="px-4 py-3">
									<span class="block">{t.unitsCount(list.length)}</span>
									<span class="mt-1 flex flex-wrap gap-1">
										{#each list as u (u.id)}{@const s = unitSummary(u)}<StatusBadge label="{u.label} · {s.label}" tone={s.tone} />{/each}
									</span>
								</td>
								<td class="px-4 py-3 whitespace-nowrap tabular-nums">{rentRange(list)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<ul class="space-y-3">
				{#each shown as p (p.id)}
					{@const list = unitsOf(p)}
					<li data-testid="bien">
						<a
							class="block space-y-2 rounded-xl border bg-card p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
							href={resolve('/app/biens/[id]', { id: p.id })}
						>
							<span class="flex items-start gap-3">
								<Building2 class="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
								<span class="min-w-0">
									<span class="block font-semibold break-words">{p.name}</span>
									<span class="block text-sm text-muted-foreground"
										>{t.types[p.type]}{p.neighborhoodId ? ` · ${neighborhoods[p.neighborhoodId] ?? ''}` : ''} · {t.recordStatus[
											p.recordStatus
										]}</span
									>
								</span>
							</span>
							<span class="block text-base">{t.unitsCount(list.length)}{rentRange(list) ? ` · ${rentRange(list)}` : ''}</span>
							{#if list.length}
								<span class="flex flex-wrap gap-1">
									{#each list as u (u.id)}{@const s = unitSummary(u)}<StatusBadge label="{u.label} · {s.label}" tone={s.tone} />{/each}
								</span>
							{/if}
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</main>
