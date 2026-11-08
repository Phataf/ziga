<script lang="ts">
	/** Ordinateur : barre du haut (date du jour, profil). La recherche globale arrive avec les écrans métier. */
	import { formatDate } from '@ziga/shared/dates';
	import { fr } from '#lib/i18n/fr.ts';
	import type { Profile } from '#lib/profiles.ts';

	let { profile }: { profile: Profile } = $props();
</script>

<header class="sticky top-0 z-30 flex h-16 items-center gap-4 border-b bg-background/95 px-8 backdrop-blur" data-testid="barre-haut">
	<p class="font-medium">{profile.label}</p>
	<p class="ml-auto text-muted-foreground">{fr.app.today(formatDate(new Date()))}</p>
</header>
