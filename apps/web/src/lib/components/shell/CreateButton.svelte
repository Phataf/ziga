<script lang="ts">
	/**
	 * Bouton global « Créer » (docs/UX.md §10), sur tablette et ordinateur : un menu avec un bien (lot 07) et un bail
	 * (lot 08 ; le locataire se crée avec son bail, depuis une unité disponible). La dépense s'ajoutera au lot 10.
	 * Chaque entrée suit la permission du rôle (l'API décide de toute façon) ; Échap ferme le menu.
	 */
	import { Building2, KeyRound, Plus } from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import { can } from '@ziga/shared/permissions';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { cn } from '#lib/utils.ts';

	let { compact = false }: { compact?: boolean } = $props();
	const role = $derived(organizations.active?.role);
	const canProperty = $derived(can(role, 'property.manage'));
	const canLease = $derived(can(role, 'lease.create'));
	const entry = 'flex min-h-11 items-center gap-2 rounded-lg px-3 text-base hover:bg-accent focus-visible:bg-accent';
	let open = $state(false);

	function onKey(event: KeyboardEvent) {
		if (event.key === 'Escape') open = false;
	}
</script>

<svelte:window onkeydown={onKey} />

{#if canProperty || canLease}
	<div class="relative">
		<button
			type="button"
			class={cn(
				'inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:ring-[3px] focus-visible:ring-ring/50',
				compact ? 'mx-2 min-h-14 flex-col gap-1 px-1 text-sm' : 'min-h-11 px-4 text-base'
			)}
			aria-expanded={open}
			aria-haspopup="menu"
			title={fr.properties.createMenu}
			data-testid="bouton-creer"
			onclick={() => (open = !open)}
		>
			<Plus class={compact ? 'size-6' : 'size-5'} aria-hidden="true" />{fr.properties.create}
		</button>
		{#if open}
			<ul class="bg-popover text-popover-foreground absolute z-30 mt-1 min-w-56 rounded-xl border p-1 shadow-lg" role="menu">
				{#if canProperty}
					<li role="none">
						<a role="menuitem" href={resolve('/app/biens/assistant')} class={entry} data-testid="creer-bien" onclick={() => (open = false)}
							><Building2 class="size-5" aria-hidden="true" />{fr.properties.createProperty}</a
						>
					</li>
				{/if}
				{#if canLease}
					<li role="none">
						<a
							role="menuitem"
							href={resolve('/app/baux/assistant')}
							class={entry}
							data-testid="creer-un-bail"
							onclick={() => (open = false)}><KeyRound class="size-5" aria-hidden="true" />{fr.leases.createLease}</a
						>
					</li>
				{/if}
			</ul>
		{/if}
	</div>
{/if}
