<script lang="ts">
	/** Affiche l'écran demandé dans la navigation du profil : « Plus » sur téléphone, sinon l'écran vide du lot. */
	import { page } from '$app/state';
	import { fr } from '#lib/i18n/fr.ts';
	import { normalizePath, screenOf, type Profile } from '#lib/profiles.ts';
	import EmptyScreen from './EmptyScreen.svelte';
	import MoreScreen from './MoreScreen.svelte';
	import PageHeader from './PageHeader.svelte';

	let { profile }: { profile: Profile } = $props();
	const path = $derived(normalizePath(page.url.pathname));
	const screen = $derived(screenOf(profile, path));
</script>

{#if screen?.phoneOnly}
	<MoreScreen {profile} />
{:else if screen}
	<EmptyScreen {screen} subtitle={profile.label} />
{:else}
	<PageHeader title={fr.app.notFound} back={profile.home} />
{/if}
