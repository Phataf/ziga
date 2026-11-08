<script lang="ts">
	/** Back-office de la plateforme : pensé pour l'ordinateur, utilisable sur tablette (docs/UX.md §2). */
	import { Monitor } from '@lucide/svelte';
	import AppShell from '$lib/components/shell/AppShell.svelte';
	import { demo } from '$lib/demo.svelte';
	import { device } from '$lib/device.svelte';

	let { children } = $props();

	if (demo.profile.space !== 'admin') demo.setProfile('admin');
</script>

<AppShell>
	{#if device.isPhone}
		<p class="flex items-center gap-2 bg-info-soft px-4 py-2 text-base text-info-foreground" role="note">
			<Monitor class="size-5 shrink-0" aria-hidden="true" /> Le back-office est conçu pour l’ordinateur.
		</p>
	{/if}
	{@render children()}
</AppShell>
