<script lang="ts">
	/** Ordinateur : barre du haut (date du jour, profil). La recherche globale arrive avec les écrans métier. */
	import { formatDate } from '@ziga/shared/dates';
	import { auth } from '#lib/auth/auth.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import type { Profile } from '#lib/profiles.ts';

	let { profile }: { profile: Profile } = $props();
</script>

<header class="sticky top-0 z-30 flex h-16 items-center gap-4 border-b bg-background/95 px-8 backdrop-blur" data-testid="barre-haut">
	<p class="font-medium">
		{#if auth.user}<span data-testid="nom-barre-haut">{auth.user.name}</span> ·
		{/if}{profile.label}
	</p>
	{#if auth.status === 'offline'}<p class="rounded-full bg-warning-soft px-3 py-1 text-sm text-warning-foreground" role="status">
			{fr.auth.offline}
		</p>{/if}
	<p class="ml-auto text-muted-foreground">{fr.app.today(formatDate(new Date()))}</p>
</header>
