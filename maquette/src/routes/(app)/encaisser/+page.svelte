<script lang="ts">
	import { Keyboard, Wallet } from '@lucide/svelte';
	import TenantPicker from '$lib/components/agency/TenantPicker.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { device } from '$lib/device.svelte';
</script>

<PageHeader title="Encaisser" subtitle="Étape 1 : choisir le locataire" back="/encaissements" backLabel="Encaissements" />

<main class="page pt-3 lg:grid lg:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)] lg:items-start lg:gap-6">
	<TenantPicker autofocus />
	<!-- Tablette et ordinateur : le formulaire s'ouvrira à droite, sans quitter la liste. -->
	{#if device.twoPane}
	<section class="sticky top-20 rounded-xl border border-dashed bg-card p-8 text-center" aria-label="Formulaire d’encaissement">
		<Wallet class="mx-auto size-10 text-muted-foreground" aria-hidden="true" />
		<p class="mt-3 text-lg font-semibold">Choisissez un locataire</p>
		<p class="text-muted-foreground">Le formulaire s’ouvre ici, montant déjà rempli.</p>
		<p class="mt-4 hidden items-center justify-center gap-2 text-muted-foreground xl:flex">
			<Keyboard class="size-5" aria-hidden="true" /> Tapez un nom puis Entrée pour aller plus vite.
		</p>
	</section>
	{/if}
</main>
