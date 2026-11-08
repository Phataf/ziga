<script lang="ts">
	import { Monitor } from '@lucide/svelte';
	import AppShell from '#lib/components/shell/AppShell.svelte';
	import { auth } from '#lib/auth/auth.svelte.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { adminProfileFor } from '#lib/profiles.ts';

	let { children } = $props();
	const profile = $derived(adminProfileFor(auth.user?.platformRole));
</script>

<AppShell {profile}>
	{#if device.isPhone}
		<p class="flex items-center gap-2 bg-info-soft px-4 py-2 text-base text-info-foreground" role="note">
			<Monitor class="size-5 shrink-0" aria-hidden="true" />{fr.app.phoneOnlyAdmin}
		</p>
	{/if}
	{@render children()}
</AppShell>
