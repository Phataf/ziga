<script lang="ts">
	import AppShell from '#lib/components/shell/AppShell.svelte';
	import { profiles } from '#lib/profiles.ts';

	let { children } = $props();
</script>

<AppShell profile={profiles.tenant}>{@render children()}</AppShell>
