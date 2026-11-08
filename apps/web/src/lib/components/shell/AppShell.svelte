<script lang="ts">
	/**
	 * Coque de l'application, une par appareil (docs/UX.md §3) :
	 * - téléphone (< 768 px) : contenu et barre d'onglets en bas ;
	 * - tablette (768–1279 px) : rail de navigation à gauche ;
	 * - ordinateur (≥ 1280 px) : menu latéral et barre du haut.
	 * Une seule forme est rendue à la fois ({#if}), jamais deux masquées en CSS.
	 */
	import type { Snippet } from 'svelte';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import type { Profile } from '#lib/profiles.ts';
	import NavRail from './NavRail.svelte';
	import Sidebar from './Sidebar.svelte';
	import TabBar from './TabBar.svelte';
	import TopBar from './TopBar.svelte';

	let { profile, children }: { profile: Profile; children: Snippet } = $props();
	const spaceLabel = $derived(profile.id === 'landlord' ? fr.spaces.landlord : fr.spaces[profile.space]);
</script>

{#if device.isPhone}
	<div class="min-h-dvh pb-28" data-coque="telephone">
		{@render children()}
	</div>
	<TabBar {profile} />
{:else if device.isTablet}
	<NavRail {profile} />
	<div class="min-h-dvh pb-10 pl-28" data-coque="tablette">
		{@render children()}
	</div>
{:else}
	<Sidebar {profile} {spaceLabel} />
	<div class="min-h-dvh pb-10 pl-64" data-coque="ordinateur">
		<TopBar {profile} />
		{@render children()}
	</div>
{/if}
