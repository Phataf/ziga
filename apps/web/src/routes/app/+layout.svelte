<script lang="ts">
	import AppShell from '#lib/components/shell/AppShell.svelte';
	import { session } from '#lib/session.svelte.ts';

	let { children } = $props();
	const profile = $derived(session.profileFor('agency'));
</script>

<AppShell {profile}>{@render children()}</AppShell>
