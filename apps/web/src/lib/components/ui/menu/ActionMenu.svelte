<script lang="ts" module>
	import type { House } from '@lucide/svelte';
	export interface MenuAction {
		label: string;
		icon?: typeof House;
		href?: string;
		target?: string;
		onclick?: () => void;
		tone?: 'default' | 'danger';
		disabled?: boolean;
	}
</script>

<script lang="ts">
	/**
	 * Menu d'actions d'une ligne de tableau (ordinateur et tablette).
	 * Sur téléphone, ces actions sont des boutons visibles ; ici elles se replient derrière « Actions ».
	 * Clavier : Entrée ou flèche bas ouvre, flèches haut et bas parcourent, Échap ferme.
	 */
	import { EllipsisVertical } from '@lucide/svelte';
	import { cn } from '#lib/utils.ts';
	import { fr } from '#lib/i18n/fr.ts';

	let { actions, label = fr.app.actions }: { actions: MenuAction[]; label?: string } = $props();

	let open = $state(false);
	let root = $state<HTMLElement | null>(null);
	let trigger = $state<HTMLButtonElement | null>(null);
	const id = `menu-${Math.random().toString(36).slice(2, 8)}`;

	function items(): HTMLElement[] {
		return [...(root?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])];
	}

	function show(focusFirst = true) {
		open = true;
		if (focusFirst) queueMicrotask(() => items()[0]?.focus());
	}

	function close(restore = true) {
		open = false;
		if (restore) trigger?.focus();
	}

	function onKeydown(e: KeyboardEvent) {
		if (!open) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				show();
			}
			return;
		}
		const list = items();
		const i = list.indexOf(document.activeElement as HTMLElement);
		if (e.key === 'Escape') {
			e.preventDefault();
			close();
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			list[(i + 1) % list.length]?.focus();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			list[(i - 1 + list.length) % list.length]?.focus();
		} else if (e.key === 'Tab') {
			close(false);
		}
	}

	function onWindowClick(e: MouseEvent) {
		if (open && root && !root.contains(e.target as Node)) close(false);
	}
</script>

<svelte:window onclick={onWindowClick} />

<div class="relative inline-block" bind:this={root} onkeydown={onKeydown} role="presentation">
	<button
		bind:this={trigger}
		type="button"
		class="flex size-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
		aria-haspopup="menu"
		aria-expanded={open}
		aria-controls={id}
		aria-label={label}
		onclick={() => (open ? close() : show())}
	>
		<EllipsisVertical class="size-5" aria-hidden="true" />
	</button>
	{#if open}
		<div {id} role="menu" class="absolute top-full right-0 z-40 mt-1 min-w-56 rounded-xl border bg-card p-1 shadow-lg">
			{#each actions as a (a.label)}
				{#if a.href && !a.disabled}
					<!-- Composant générique : l'appelant passe un lien déjà résolu (resolve() de $app/paths). -->
					<!-- eslint-disable svelte/no-navigation-without-resolve -->
					<a
						role="menuitem"
						tabindex="-1"
						href={a.href}
						target={a.target}
						rel={a.target ? 'noopener' : undefined}
						class={cn(
							'flex min-h-10 items-center gap-2 rounded-lg px-3 hover:bg-accent focus:bg-accent focus:outline-none',
							a.tone === 'danger' && 'text-destructive'
						)}
						onclick={() => {
							a.onclick?.();
							close(false);
						}}
					>
						{#if a.icon}<a.icon class="size-[18px] shrink-0" aria-hidden="true" />{/if}
						{a.label}
					</a>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
				{:else}
					<button
						type="button"
						role="menuitem"
						tabindex="-1"
						aria-disabled={a.disabled ? 'true' : undefined}
						class={cn(
							'flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-left hover:bg-accent focus:bg-accent focus:outline-none',
							a.tone === 'danger' && 'text-destructive',
							a.disabled && 'cursor-not-allowed opacity-50'
						)}
						onclick={() => {
							if (a.disabled) return;
							a.onclick?.();
							close();
						}}
					>
						{#if a.icon}<a.icon class="size-[18px] shrink-0" aria-hidden="true" />{/if}
						{a.label}
					</button>
				{/if}
			{/each}
		</div>
	{/if}
</div>
