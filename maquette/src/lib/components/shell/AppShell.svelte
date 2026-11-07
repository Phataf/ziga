<script lang="ts">
	/**
	 * Coque de l'application, différente par appareil (docs/UX.md §3) :
	 * - téléphone (< 768 px) : bandeau de démo, contenu, barre d'onglets en bas ;
	 * - tablette (768–1279 px) : rail de navigation à gauche, contenu sur toute la largeur ;
	 * - ordinateur (≥ 1280 px) : menu latéral, barre du haut avec recherche, contenu jusqu'à 80 rem.
	 */
	import type { Snippet } from 'svelte';
	import TabBar from '$lib/components/TabBar.svelte';
	import { device } from '$lib/device.svelte';
	import NavRail from './NavRail.svelte';
	import ProfileSwitcher from './ProfileSwitcher.svelte';
	import Sidebar from './Sidebar.svelte';
	import TopBar from './TopBar.svelte';

	let { children }: { children: Snippet } = $props();
</script>

{#if device.kind === 'phone'}
	<ProfileSwitcher variant="strip" />
{:else if device.kind === 'tablet'}
	<NavRail />
{:else}
	<Sidebar />
{/if}
<div class="min-h-dvh pb-28 md:pb-10 md:pl-28 xl:pl-64">
	{#if device.isDesktop}<TopBar />{/if}
	{@render children()}
</div>
{#if device.isPhone}<TabBar />{/if}
