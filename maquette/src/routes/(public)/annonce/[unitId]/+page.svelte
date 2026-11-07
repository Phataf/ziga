<script lang="ts">
	import { page } from '$app/state';
	import { Bed, Check, MapPin, MessageCircle, Phone, Ruler, ShieldCheck } from '@lucide/svelte';
	import PhotoPlaceholder from '$lib/components/PhotoPlaceholder.svelte';
	import { Button } from '$lib/components/ui/button';
	import { demo } from '$lib/demo.svelte';
	import { formatFCFA, formatPhone } from '$lib/format';
	import { isListed, listingTitle } from '$lib/listing';
	import { listingMessage, waLink } from '$lib/whatsapp';

	const unit = $derived(demo.data.units.find((u) => u.id === page.params.unitId));
	const property = $derived(unit ? demo.data.properties.find((p) => p.id === unit.propertyId) : undefined);
	const visible = $derived(!!unit && isListed(unit));
	const title = $derived(unit && property ? listingTitle(unit, property.district) : '');
	const agency = $derived(demo.data.agency);

	let slide = $state(0);
	function onScroll(e: Event) {
		const el = e.currentTarget as HTMLElement;
		slide = Math.round(el.scrollLeft / el.clientWidth);
	}
</script>

<svelte:head><title>{visible ? `${title} — ${agency.name}` : 'Annonce indisponible'}</title></svelte:head>

{#if !unit || !property || !visible}
	<main class="mx-auto max-w-lg space-y-3 p-4 text-center" data-testid="annonce-indisponible">
		<h1 class="text-xl font-bold">Cette annonce n’est plus disponible</h1>
		<p class="text-muted-foreground">Le logement a été loué ou retiré par l’agence.</p>
		<Button href="/vitrine" variant="outline">Voir les logements disponibles</Button>
	</main>
{:else}
	<main class="mx-auto max-w-lg pb-28" data-testid="annonce">
		<div class="relative">
			<div class="flex aspect-[400/260] snap-x snap-mandatory overflow-x-auto" onscroll={onScroll} aria-label="Photos du logement">
				{#each Array.from({ length: unit.photos }, (_, i) => i) as i (i)}
					<div class="w-full shrink-0 snap-center"><PhotoPlaceholder index={i} total={unit.photos} /></div>
				{/each}
			</div>
			<span class="absolute right-3 bottom-3 rounded-full bg-black/60 px-3 py-0.5 text-base text-white">
				{slide + 1} / {unit.photos}
			</span>
		</div>

		<div class="space-y-4 p-4">
			<div class="space-y-1">
				<p class="text-3xl font-bold text-primary">{formatFCFA(unit.rent)} <span class="text-lg font-normal text-muted-foreground">/ mois</span></p>
				<h1 class="text-xl font-semibold">{title}</h1>
				<p class="flex items-center gap-1 text-muted-foreground">
					<MapPin class="size-5" aria-hidden="true" /> {property.district}, {property.city}
				</p>
			</div>

			<p class="flex items-center gap-2 rounded-xl bg-success-soft p-3 font-medium text-secondary-foreground" data-testid="mention-mandat">
				<ShieldCheck class="size-6 shrink-0 text-primary" aria-hidden="true" />
				Géré sous mandat par {agency.name}
			</p>

			<ul class="grid grid-cols-2 gap-2">
				<li class="flex items-center gap-2 rounded-lg border p-3"><Bed class="size-5 text-primary" aria-hidden="true" /> {unit.rooms} pièce{unit.rooms > 1 ? 's' : ''}</li>
				<li class="flex items-center gap-2 rounded-lg border p-3"><Ruler class="size-5 text-primary" aria-hidden="true" /> {unit.surface} m²</li>
			</ul>

			{#if unit.features.length}
				<section aria-labelledby="titre-carac">
					<h2 id="titre-carac" class="mb-1 text-lg font-semibold">Caractéristiques</h2>
					<ul class="space-y-1">
						{#each unit.features as f (f)}
							<li class="flex items-center gap-2"><Check class="size-5 text-primary" aria-hidden="true" /> {f}</li>
						{/each}
					</ul>
				</section>
			{/if}

			{#if unit.description}
				<section aria-labelledby="titre-desc">
					<h2 id="titre-desc" class="mb-1 text-lg font-semibold">Description</h2>
					<p>{unit.description}</p>
				</section>
			{/if}

			<section class="rounded-xl border p-3" aria-labelledby="titre-agence">
				<h2 id="titre-agence" class="font-semibold">{agency.name}</h2>
				<p class="text-muted-foreground">{agency.address}</p>
				<p class="text-muted-foreground">{formatPhone(agency.phone)}</p>
			</section>
		</div>

		<div class="fixed inset-x-0 bottom-0 z-30 border-t bg-white/95 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur">
			<div class="mx-auto grid max-w-lg grid-cols-2 gap-2">
				<Button
					variant="whatsapp"
					size="lg"
					target="_blank"
					rel="noopener"
					href={waLink(agency.phone, listingMessage({ title, rent: unit.rent, url: page.url.href }))}
					data-testid="contact-whatsapp"
				>
					<MessageCircle class="size-6" aria-hidden="true" /> WhatsApp
				</Button>
				<Button variant="outline" size="lg" href="tel:{agency.phone}" data-testid="contact-appel">
					<Phone class="size-6" aria-hidden="true" /> Appeler
				</Button>
			</div>
		</div>
	</main>
{/if}
