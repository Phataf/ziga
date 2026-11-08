<script lang="ts">
	import { page } from '$app/state';
	import EmptyScreen from '#lib/components/EmptyScreen.svelte';
	import { profiles } from '#lib/profiles.ts';

	const screen = $derived(profiles.visitor.nav.find((i) => i.href === page.url.pathname)!);
</script>

<EmptyScreen {screen} />
