<script lang="ts">
	import type { Path } from '$app/types';
	import { resolve } from '$app/paths';
	/**
	 * En-tête de page.
	 * Téléphone : barre collante compacte avec bouton retour.
	 * Tablette et ordinateur : titre de page plus grand, fil d'Ariane à la place du bouton retour,
	 * et zone d'actions alignée à droite (les actions deviennent des boutons visibles).
	 */
	import { ChevronLeft, ChevronRight } from '@lucide/svelte';
	import type { Snippet } from 'svelte';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';

	let {
		title,
		subtitle,
		back,
		backLabel = fr.app.back,
		actions,
		flush = false,
		class: className = ''
	}: {
		title: string;
		subtitle?: string;
		back?: Path;
		backLabel?: string;
		actions?: Snippet;
		/** Dans une colonne déjà mise en page (vue liste-détail) : pas de marges latérales sur tablette et ordinateur. */
		flush?: boolean;
		class?: string;
	} = $props();
</script>

<svelte:head><title>{fr.app.pageTitle(title)}</title></svelte:head>

<header
	class="sticky top-0 z-30 border-b bg-background/95 backdrop-blur md:static md:border-b-0 md:bg-transparent md:backdrop-blur-none {className}"
>
	<div class="page flex items-center gap-1 !px-2 py-2 md:pt-6 md:pb-2 {flush ? 'md:!max-w-none md:!px-0 md:!pt-0' : 'md:!px-6 xl:!px-8'}">
		{#if back && device.isPhone}
			<a
				href={resolve(back)}
				class="flex min-h-11 items-center gap-0.5 rounded-lg pr-2 text-primary hover:bg-accent md:hidden"
				aria-label={backLabel}
			>
				<ChevronLeft class="size-6" aria-hidden="true" />
				<span class="text-base">{backLabel}</span>
			</a>
		{/if}
		<div class="min-w-0 flex-1 px-2 md:px-0">
			{#if back && !device.isPhone}
				<nav aria-label={fr.app.breadcrumb} class="hidden md:block">
					<a href={resolve(back)} class="inline-flex items-center gap-1 text-base text-muted-foreground hover:text-primary">
						{backLabel}<ChevronRight class="size-4" aria-hidden="true" />
					</a>
				</nav>
			{/if}
			<h1 class="truncate text-xl font-bold md:text-2xl xl:text-3xl">{title}</h1>
			{#if subtitle}<p class="truncate text-base text-muted-foreground">{subtitle}</p>{/if}
		</div>
		{#if actions}
			<div class="flex shrink-0 items-center gap-2">{@render actions()}</div>
		{/if}
	</div>
</header>
