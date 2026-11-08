<script lang="ts">
	import { page } from '$app/state';
	import AppShell from '#lib/components/shell/AppShell.svelte';
	import { session } from '#lib/session.svelte.ts';

	let { children } = $props();
	$effect.pre(() => session.syncFromUrl(page.url));
	const profile = $derived(session.profileFor('agency'));
</script>

<AppShell {profile}>{@render children()}</AppShell>
