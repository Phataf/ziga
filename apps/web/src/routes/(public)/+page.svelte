<script lang="ts">
	import { fr } from '#lib/i18n/fr.ts';
</script>

<svelte:head><title>{fr.app.pageTitle(fr.vitrine.title)}</title></svelte:head>

<main class="page space-y-2 py-10" data-testid="vitrine">
	<h1 class="text-2xl font-bold md:text-3xl">{fr.vitrine.title}</h1>
	<p class="text-muted-foreground">{fr.vitrine.subtitle}</p>
	<p class="text-muted-foreground">{fr.app.emptyScreen} 12.</p>
</main>
