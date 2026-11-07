<script lang="ts">
	/**
	 * Panneau modal qui change de forme selon l'appareil (docs/UX.md §4) :
	 * feuille ancrée en bas sur téléphone, boîte de dialogue centrée sur tablette,
	 * et, avec side="right", tiroir latéral sur ordinateur.
	 */
	import type { Snippet } from 'svelte';
	import { X } from '@lucide/svelte';
	import { cn } from '$lib/utils';

	let {
		open = $bindable(false),
		labelledby,
		side = 'center',
		class: className = '',
		closeLabel = 'Fermer',
		children
	}: {
		open?: boolean;
		labelledby: string;
		side?: 'center' | 'right';
		class?: string;
		closeLabel?: string;
		children: Snippet;
	} = $props();

	let panel = $state<HTMLElement | null>(null);
	let previous: HTMLElement | null = null;

	$effect(() => {
		if (!open) return;
		previous = document.activeElement as HTMLElement | null;
		const first = panel?.querySelector<HTMLElement>('input, button:not([data-close]), a, [tabindex]:not([tabindex="-1"])');
		(first ?? panel)?.focus();
		return () => previous?.focus?.();
	});

	function onKeydown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			open = false;
		}
		if (e.key === 'Tab' && panel) {
			const items = [...panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])')];
			if (!items.length) return;
			const first = items[0];
			const last = items[items.length - 1];
			if (e.shiftKey && document.activeElement === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
	<div
		class={cn(
			'fixed inset-0 z-50 flex bg-black/40',
			side === 'right' ? 'items-end md:items-center md:justify-center xl:items-stretch xl:justify-end' : 'items-end md:items-center md:justify-center'
		)}
		role="presentation"
		onclick={(e) => e.target === e.currentTarget && (open = false)}
	>
		<div
			bind:this={panel}
			tabindex="-1"
			class={cn(
				'relative max-h-[92dvh] w-full overflow-y-auto bg-card p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-xl outline-none',
				'rounded-t-2xl md:max-w-lg md:rounded-2xl md:p-6',
				side === 'right' && 'xl:h-dvh xl:max-h-none xl:max-w-md xl:rounded-none xl:border-l',
				className
			)}
			role="dialog"
			aria-modal="true"
			aria-labelledby={labelledby}
		>
			<div class="mx-auto mb-3 h-1.5 w-12 rounded-full bg-muted md:hidden" aria-hidden="true"></div>
			<button
				type="button"
				data-close
				class="absolute top-3 right-3 hidden size-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent md:flex"
				onclick={() => (open = false)}
				aria-label={closeLabel}
			>
				<X class="size-5" aria-hidden="true" />
			</button>
			{@render children()}
		</div>
	</div>
{/if}
