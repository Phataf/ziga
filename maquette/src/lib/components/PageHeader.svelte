<script lang="ts">
	import { ChevronLeft } from '@lucide/svelte';
	import type { Snippet } from 'svelte';

	let {
		title,
		subtitle,
		back,
		backLabel = 'Retour',
		actions
	}: { title: string; subtitle?: string; back?: string; backLabel?: string; actions?: Snippet } = $props();
</script>

<header class="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
	<div class="mx-auto flex max-w-lg items-center gap-1 px-2 py-2">
		{#if back}
			<a
				href={back}
				class="flex min-h-11 items-center gap-0.5 rounded-lg pr-2 text-primary hover:bg-accent"
				aria-label={backLabel}
			>
				<ChevronLeft class="size-6" aria-hidden="true" />
				<span class="text-base">{backLabel}</span>
			</a>
		{/if}
		<div class="min-w-0 flex-1 px-2">
			<h1 class="truncate text-xl font-bold">{title}</h1>
			{#if subtitle}<p class="truncate text-base text-muted-foreground">{subtitle}</p>{/if}
		</div>
		{@render actions?.()}
	</div>
</header>
