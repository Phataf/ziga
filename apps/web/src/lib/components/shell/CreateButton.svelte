<script lang="ts">
	/**
	 * Bouton global « Créer » (docs/UX.md §10), sur tablette et ordinateur : au lot 07, un bien ; locataire, bail et
	 * dépense s'ajouteront avec leurs lots. Seulement si le rôle peut gérer les biens (l'API décide de toute façon).
	 */
	import { Plus } from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import { can } from '@ziga/shared/permissions';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { cn } from '#lib/utils.ts';

	let { compact = false }: { compact?: boolean } = $props();
	const shown = $derived(can(organizations.active?.role, 'property.manage'));
</script>

{#if shown}
	<a
		href={resolve('/app/biens/assistant')}
		class={cn(
			'inline-flex items-center justify-center gap-2 rounded-lg bg-primary font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:ring-[3px] focus-visible:ring-ring/50',
			compact ? 'mx-2 min-h-14 flex-col gap-1 px-1 text-sm' : 'min-h-11 px-4 text-base'
		)}
		title="{fr.properties.create} : {fr.properties.createProperty.toLowerCase()}"
		data-testid="bouton-creer"
	>
		<Plus class={compact ? 'size-6' : 'size-5'} aria-hidden="true" />{fr.properties.create}
	</a>
{/if}
