<script lang="ts">
	import TabBar from '$lib/components/TabBar.svelte';

	let { children } = $props();
</script>

<div class="min-h-dvh pb-28">
	{@render children()}
</div>
<TabBar />
