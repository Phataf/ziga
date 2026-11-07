<script lang="ts">
	/** Ordinateur : barre du haut avec recherche globale, alertes et date du jour. */
	import { Bell, Search } from '@lucide/svelte';
	import { demo } from '$lib/demo.svelte';
	import { formatDate } from '$lib/format';
	import { arrears } from '$lib/views';
	import CommandPalette from './CommandPalette.svelte';

	let searching = $state(false);
	const alerts = $derived(demo.profile.space === 'agency' ? arrears(demo.data).length : 0);
</script>

<header class="sticky top-0 z-30 hidden h-16 items-center gap-4 border-b bg-background/95 px-8 backdrop-blur xl:flex">
	{#if demo.profile.space === 'agency'}
		<button
			type="button"
			class="flex h-10 w-full max-w-md items-center gap-2 rounded-lg border-2 border-input bg-card px-3 text-left text-muted-foreground hover:border-ring"
			onclick={() => (searching = true)}
			data-testid="ouvrir-recherche"
		>
			<Search class="size-[18px]" aria-hidden="true" />
			<span class="flex-1">Rechercher un locataire, un bien…</span>
			<kbd class="rounded border bg-muted px-1.5 text-sm">Ctrl K</kbd>
		</button>
	{/if}
	<div class="ml-auto flex items-center gap-4">
		<span class="text-muted-foreground">Aujourd’hui, {formatDate(demo.today)}</span>
		{#if demo.profile.space === 'agency'}
			<a href="/impayes" class="relative flex size-10 items-center justify-center rounded-lg hover:bg-accent" aria-label="{alerts} impayés à traiter">
				<Bell class="size-5" aria-hidden="true" />
				{#if alerts}
					<span class="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-destructive text-xs font-bold text-destructive-foreground">{alerts}</span>
				{/if}
			</a>
		{/if}
	</div>
</header>

<CommandPalette bind:open={searching} />
