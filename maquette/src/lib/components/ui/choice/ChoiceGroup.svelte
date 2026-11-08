<script lang="ts" generics="T extends string">
	/** Réponses en grosses options plutôt qu'en liste déroulante (docs/UX.md §5). */
	import { Check } from '@lucide/svelte';
	import { cn } from '$lib/utils';

	let {
		legend,
		name,
		options,
		value = $bindable(),
		columns = 2,
		hideLegend = false
	}: {
		legend: string;
		name: string;
		options: { value: T; label: string; hint?: string }[];
		value: T;
		columns?: 1 | 2 | 3 | 4;
		hideLegend?: boolean;
	} = $props();
	const grid = { 1: 'grid-cols-1', 2: 'grid-cols-1 sm:grid-cols-2', 3: 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3', 4: 'grid-cols-2 xl:grid-cols-4' };
</script>

<fieldset class="space-y-2">
	<legend class={cn('mb-2 text-lg font-semibold', hideLegend && 'sr-only')}>{legend}</legend>
	<div class={cn('grid gap-2', grid[columns])}>
		{#each options as o (o.value)}
			<label
				class={cn(
					'flex min-h-12 min-w-0 cursor-pointer items-center gap-3 rounded-lg border-2 bg-card px-3 py-2 has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/40',
					value === o.value ? 'border-primary bg-secondary text-secondary-foreground' : 'border-input hover:bg-accent'
				)}
			>
				<input type="radio" class="sr-only" {name} value={o.value} bind:group={value} />
				<span
					class={cn('flex size-6 shrink-0 items-center justify-center rounded-full border-2', value === o.value ? 'border-primary bg-primary text-primary-foreground' : 'border-input')}
					aria-hidden="true"
				>
					{#if value === o.value}<Check class="size-4" />{/if}
				</span>
				<span class="min-w-0">
					<span class="block font-medium">{o.label}</span>
					{#if o.hint}<span class="block text-base text-muted-foreground">{o.hint}</span>{/if}
				</span>
			</label>
		{/each}
	</div>
</fieldset>
