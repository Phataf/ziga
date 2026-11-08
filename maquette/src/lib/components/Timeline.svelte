<script lang="ts" module>
	export interface TimelineEvent {
		date: string;
		title: string;
		detail?: string;
		/** Qui a fait l'action. */
		author?: string;
		/** Organisation concernée (espaces personnels). */
		organization?: string;
		/** Pièce jointe : justificatif, reçu, accord. */
		attachment?: string;
		tone?: 'default' | 'success' | 'warning' | 'danger';
	}
</script>

<script lang="ts">
	/** Chronologie (docs/UX.md §10) : chaque événement daté, avec son auteur, son organisation et sa pièce jointe. */
	import { Building2, Paperclip, User } from '@lucide/svelte';
	import { formatDate } from '$lib/format';
	import { cn } from '$lib/utils';

	let { events, label, testid }: { events: TimelineEvent[]; label: string; testid?: string } = $props();
	const dot = { default: 'bg-muted-foreground', success: 'bg-primary', warning: 'bg-warning', danger: 'bg-destructive' };
</script>

<ol class="relative space-y-4 border-l-2 border-border pl-5" aria-label={label} data-testid={testid}>
	{#each events as e, i (i)}
		<li class="relative">
			<span class={cn('absolute top-1.5 -left-[1.6rem] size-3 rounded-full ring-4 ring-background', dot[e.tone ?? 'default'])} aria-hidden="true"></span>
			<p class="text-base text-muted-foreground tabular-nums">{formatDate(e.date)}</p>
			<p class="font-semibold">{e.title}</p>
			{#if e.detail}<p class="text-base">{e.detail}</p>{/if}
			<p class="flex flex-wrap gap-x-4 gap-y-1 text-base text-muted-foreground">
				{#if e.author}<span class="flex items-center gap-1"><User class="size-4" aria-hidden="true" />{e.author}</span>{/if}
				{#if e.organization}<span class="flex items-center gap-1"><Building2 class="size-4" aria-hidden="true" />{e.organization}</span>{/if}
				{#if e.attachment}<span class="flex items-center gap-1"><Paperclip class="size-4" aria-hidden="true" />{e.attachment}</span>{/if}
			</p>
		</li>
	{:else}
		<li class="text-muted-foreground">Aucun événement.</li>
	{/each}
</ol>
