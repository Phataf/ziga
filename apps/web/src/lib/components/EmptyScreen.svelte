<script lang="ts">
	/** Écran prévu mais pas encore construit : son titre et le lot qui le livrera. */
	import { Hammer } from '@lucide/svelte';
	import { fr } from '#lib/i18n/fr.ts';
	import type { NavItem } from '#lib/profiles.ts';
	import PageHeader from './PageHeader.svelte';

	let { screen, subtitle }: { screen: NavItem; subtitle?: string } = $props();
</script>

<PageHeader title={screen.label} {subtitle} />
<main class="page pt-3" data-testid="ecran-vide">
	<p class="flex items-center gap-3 rounded-xl border border-dashed bg-card p-4 text-muted-foreground">
		<Hammer class="size-5 shrink-0" aria-hidden="true" />
		{screen.lot ? `${fr.app.emptyScreen} ${screen.lot}.` : fr.app.emptyScreenNoLot}
	</p>
</main>
