<script lang="ts">
	/** Indique l'organisation concernée par un élément d'un espace personnel (règle 15). */
	import { Building2, House } from '@lucide/svelte';
	import type { Agency } from '$lib/types';

	let { organization }: { organization: Agency } = $props();
</script>

<span class="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-base text-muted-foreground" data-testid="organisation">
	{#if organization.kind === 'landlord'}
		<House class="size-4" aria-hidden="true" /> Gestion directe
	{:else}
		<Building2 class="size-4" aria-hidden="true" /> {organization.name}
	{/if}
</span>
