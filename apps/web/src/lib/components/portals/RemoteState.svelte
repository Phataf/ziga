<script lang="ts">
	/** Chargement, erreur avec « Réessayer », puis le contenu d'un écran d'espace personnel lu en ligne. */
	import type { Snippet } from 'svelte';
	import { RotateCw } from '@lucide/svelte';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import type { Remote } from '#lib/portals/remote.svelte.ts';

	let { remote, children }: { remote: Remote<unknown>; children: Snippet } = $props();
</script>

{#if remote.loading && !remote.data}
	<p class="text-base text-muted-foreground" role="status" data-testid="espace-chargement">{fr.ownerSpace.loading}</p>
{:else if remote.error && !remote.data}
	<div class="space-y-3">
		<FormAlert message={remote.error} />
		<Button variant="outline" onclick={() => remote.load()}><RotateCw class="size-5" aria-hidden="true" />{fr.ownerSpace.retry}</Button>
	</div>
{:else}
	{@render children()}
{/if}
