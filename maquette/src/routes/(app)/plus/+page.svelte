<script lang="ts">
	import { goto } from '$app/navigation';
	import { ChevronRight, Globe, RotateCcw, Users } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { demo } from '$lib/demo.svelte';
	import { formatPhone } from '$lib/format';

	let confirming = $state(false);

	const links = [
		{ href: '/proprietaires', label: 'Propriétaires et relevés', hint: 'Relevé du mois envoyé par lien', icon: Users },
		{ href: '/vitrine', label: 'Vitrine publique', hint: 'Les annonces vues par les visiteurs', icon: Globe }
	];

	function reset() {
		demo.reset();
		confirming = false;
		goto('/');
	}
</script>

<PageHeader title="Plus" />

<main class="mx-auto max-w-lg space-y-4 px-4 pt-3">
	<ul class="divide-y rounded-xl border bg-card">
		{#each links as l (l.href)}
			<li>
				<a href={l.href} class="flex min-h-16 items-center gap-3 p-3 hover:bg-accent">
					<l.icon class="size-6 shrink-0 text-primary" aria-hidden="true" />
					<div class="flex-1">
						<p class="font-semibold">{l.label}</p>
						<p class="text-base text-muted-foreground">{l.hint}</p>
					</div>
					<ChevronRight class="size-6 text-muted-foreground" aria-hidden="true" />
				</a>
			</li>
		{/each}
	</ul>

	<Card.Root>
		<Card.Content class="space-y-1">
			<p class="text-base text-muted-foreground">Agence</p>
			<p class="font-semibold">{demo.data.agency.name}</p>
			<p class="text-base">{demo.data.agency.address}</p>
			<p class="text-base">{formatPhone(demo.data.agency.phone)}</p>
		</Card.Content>
	</Card.Root>

	<div class="pt-8">
		{#if confirming}
			<div class="space-y-2 rounded-xl border bg-card p-3" role="alertdialog" aria-labelledby="titre-reset">
				<p id="titre-reset" class="font-medium">Effacer toutes les saisies faites pendant la démo ?</p>
				<div class="grid grid-cols-2 gap-2">
					<Button variant="outline" onclick={() => (confirming = false)}>Annuler</Button>
					<Button variant="destructive" onclick={reset}>Réinitialiser</Button>
				</div>
			</div>
		{:else}
			<Button variant="ghost" class="w-full text-muted-foreground" onclick={() => (confirming = true)}>
				<RotateCcw aria-hidden="true" /> Réinitialiser la démo
			</Button>
		{/if}
		<p class="pt-2 text-center text-base text-muted-foreground">Maquette — données fictives</p>
	</div>
</main>
