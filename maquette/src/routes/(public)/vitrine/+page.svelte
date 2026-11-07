<script lang="ts">
	import { page } from '$app/state';
	import { FileCheck, MapPin, MessageCircle, SlidersHorizontal } from '@lucide/svelte';
	import PhotoPlaceholder from '$lib/components/PhotoPlaceholder.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Sheet } from '$lib/components/ui/sheet';
	import { demo } from '$lib/demo.svelte';
	import { formatFCFA } from '$lib/format';
	import { listings } from '$lib/listing';
	import { saleListings } from '$lib/sales';
	import { cn } from '$lib/utils';
	import { waLink } from '$lib/whatsapp';

	const mode = $derived(page.url.searchParams.get('type') === 'achat' ? 'achat' : 'location');
	const agency = $derived(demo.full.agency);

	let city = $state<'all' | 'Ouagadougou' | 'Saaba'>('all');
	let budget = $state(0);
	let filtersOpen = $state(false);

	const rentals = $derived(listings(demo.full).filter((it) => (city === 'all' || it.property.city === city) && (!budget || it.unit.rent <= budget)));
	const sales = $derived(saleListings.filter((s) => (city === 'all' || s.city === city) && (!budget || s.price <= budget)));
	const count = $derived(mode === 'achat' ? sales.length : rentals.length);
	const budgets = $derived(
		mode === 'achat'
			? [0, 10_000_000, 50_000_000, 100_000_000]
			: [0, 50_000, 100_000, 150_000]
	);
	$effect(() => {
		void mode;
		budget = 0;
	});
</script>

<svelte:head><title>{agency.name} — {mode === 'achat' ? 'biens à vendre' : 'logements disponibles'}</title></svelte:head>

{#snippet filters()}
	<fieldset class="space-y-2">
		<legend class="mb-1 font-semibold">Commune</legend>
		{#each [['all', 'Toutes'], ['Ouagadougou', 'Ouagadougou'], ['Saaba', 'Saaba']] as [id, label] (id)}
			<label class={cn('flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border-2 px-3', city === id ? 'border-primary bg-secondary' : 'border-input')}>
				<input type="radio" name="commune" value={id} bind:group={city} class="size-4 accent-[var(--color-primary)]" />{label}
			</label>
		{/each}
	</fieldset>
	<fieldset class="space-y-2">
		<legend class="mb-1 font-semibold">Budget maximum</legend>
		{#each budgets as b (b)}
			<label class={cn('flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border-2 px-3', budget === b ? 'border-primary bg-secondary' : 'border-input')}>
				<input type="radio" name="budget" value={b} bind:group={budget} class="size-4 accent-[var(--color-primary)]" />{b ? `${formatFCFA(b)}${mode === 'achat' ? '' : ' / mois'}` : 'Sans limite'}
			</label>
		{/each}
	</fieldset>
{/snippet}

<div class="mx-auto max-w-7xl px-4 pt-4 pb-10 md:px-6 md:pt-8">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h1 class="text-2xl font-bold md:text-3xl">{mode === 'achat' ? 'Biens à vendre' : 'Logements à louer'}</h1>
			<p class="text-base text-muted-foreground">
				{count} {mode === 'achat' ? 'bien' : 'logement'}{count > 1 ? 's' : ''} disponible{count > 1 ? 's' : ''} · Ouagadougou et Saaba
			</p>
		</div>
		<Button variant="outline" class="lg:hidden" onclick={() => (filtersOpen = true)}>
			<SlidersHorizontal aria-hidden="true" /> Filtres
		</Button>
	</div>

	<div class="mt-4 lg:grid lg:grid-cols-[16rem_minmax(0,1fr)] lg:gap-8">
		<!-- Ordinateur : filtres toujours visibles à gauche. Téléphone et tablette : dans un panneau. -->
		<aside class="sticky top-24 hidden space-y-5 self-start lg:block" aria-label="Filtres">
			{@render filters()}
		</aside>

		<main class="grid grid-cols-1 content-start gap-4 md:grid-cols-2 xl:grid-cols-3">
			{#if mode === 'location'}
				{#each rentals as it (it.unit.id)}
					<a href="/annonce/{it.unit.id}" class="group block overflow-hidden rounded-xl border bg-card hover:shadow-md" data-testid="annonce-carte">
						<div class="aspect-[400/240] overflow-hidden"><PhotoPlaceholder index={0} total={it.unit.photos} /></div>
						<div class="space-y-1 p-4">
							<p class="text-xl font-bold">{formatFCFA(it.unit.rent)} <span class="text-base font-normal text-muted-foreground">/ mois</span></p>
							<p class="font-semibold group-hover:text-primary">{it.title}</p>
							<p class="flex items-center gap-1 text-base text-muted-foreground"><MapPin class="size-4" aria-hidden="true" /> {it.property.district}, {it.property.city}</p>
						</div>
					</a>
				{:else}
					<p class="rounded-xl border p-4 text-muted-foreground md:col-span-2 xl:col-span-3">Aucun logement ne correspond. Élargissez les filtres.</p>
				{/each}
			{:else}
				{#each sales as s (s.id)}
					<article class="flex flex-col overflow-hidden rounded-xl border bg-card" data-testid="annonce-vente">
						<div class="aspect-[400/240] overflow-hidden"><PhotoPlaceholder index={+s.id.slice(1)} total={s.photos} label={s.kind} /></div>
						<div class="flex flex-1 flex-col gap-2 p-4">
							<p class="text-xl font-bold">{formatFCFA(s.price)}</p>
							<h2 class="font-semibold">{s.title}</h2>
							<p class="flex items-center gap-1 text-base text-muted-foreground"><MapPin class="size-4" aria-hidden="true" /> {s.district}, {s.city} · {s.surface} m²</p>
							<p class="flex items-center gap-1 text-base"><FileCheck class="size-4 text-primary" aria-hidden="true" /> Document déclaré : {s.document}</p>
							<Button
								variant="whatsapp"
								class="mt-auto"
								target="_blank"
								rel="noopener"
								href={waLink(agency.phone, `Bonjour, je suis intéressé(e) par « ${s.title} » à ${s.district} (${formatFCFA(s.price)}).`)}
							>
								<MessageCircle aria-hidden="true" /> Demander une visite
							</Button>
						</div>
					</article>
				{:else}
					<p class="rounded-xl border p-4 text-muted-foreground md:col-span-2 xl:col-span-3">Aucun bien ne correspond. Élargissez les filtres.</p>
				{/each}
				<p class="text-base text-muted-foreground md:col-span-2 xl:col-span-3">
					Les documents sont déclarés par le vendeur. Vérifiez-les auprès des services compétents avant tout paiement.
				</p>
			{/if}
		</main>
	</div>
</div>

<Sheet bind:open={filtersOpen} labelledby="titre-filtres">
	<div class="space-y-5">
		<h2 id="titre-filtres" class="text-xl font-bold">Filtres</h2>
		{@render filters()}
		<Button size="lg" class="w-full" onclick={() => (filtersOpen = false)}>Voir {count} résultat{count > 1 ? 's' : ''}</Button>
	</div>
</Sheet>
