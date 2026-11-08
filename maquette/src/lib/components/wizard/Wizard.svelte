<script lang="ts">
	/**
	 * Assistant pas à pas (docs/UX.md §10) : ajout de bien, sortie du locataire.
	 * - Téléphone : une étape par écran, progression en haut, boutons fixés au-dessus des onglets.
	 * - Tablette : progression en haut, formulaire sur toute la largeur.
	 * - Ordinateur : étapes à gauche, formulaire à droite.
	 * Le brouillon est enregistré à chaque étape par la page (onstep).
	 */
	import type { Snippet } from 'svelte';
	import { Check, ChevronLeft, ChevronRight, CircleCheck } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { device } from '$lib/device.svelte';
	import { cn } from '$lib/utils';

	let {
		steps,
		current = $bindable(0),
		reached = 0,
		canNext = true,
		nextLabel = 'Enregistrer et continuer',
		finishLabel,
		savedNote,
		onstep,
		onfinish,
		children,
		testid = 'assistant'
	}: {
		steps: { id: string; label: string }[];
		current?: number;
		/** Étape la plus avancée déjà atteinte : on peut y revenir directement. */
		reached?: number;
		canNext?: boolean;
		nextLabel?: string;
		finishLabel: string;
		savedNote?: string;
		/** Appelé à chaque changement d'étape, avec la nouvelle étape : la page y enregistre le brouillon. */
		onstep?: (step: number) => void;
		onfinish: () => void;
		children: Snippet;
		testid?: string;
	} = $props();

	const last = $derived(current === steps.length - 1);
	let heading = $state<HTMLElement | null>(null);

	function go(step: number) {
		current = step;
		onstep?.(step);
		// Le focus suit l'étape : les lecteurs d'écran annoncent le nouveau titre.
		queueMicrotask(() => heading?.focus());
	}
</script>

<div class={cn('pb-28 md:pb-0', device.isDesktop && 'grid grid-cols-[16rem_minmax(0,1fr)] items-start gap-8')} data-testid={testid}>
	{#if device.isDesktop}
		<nav aria-label="Étapes" class="sticky top-20 rounded-xl border bg-card p-2">
			<ol class="space-y-1">
				{#each steps as s, i (s.id)}
					{@const done = i < current}
					<li>
						<button
							type="button"
							class={cn(
								'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left',
								i === current ? 'bg-secondary font-semibold text-secondary-foreground' : 'hover:bg-accent',
								i > Math.max(reached, current) && 'pointer-events-none opacity-50'
							)}
							aria-current={i === current ? 'step' : undefined}
							disabled={i > Math.max(reached, current)}
							onclick={() => go(i)}
						>
							<span
								class={cn(
									'flex size-7 shrink-0 items-center justify-center rounded-full border-2 text-sm font-bold',
									done ? 'border-primary bg-primary text-primary-foreground' : i === current ? 'border-primary text-primary' : 'border-input text-muted-foreground'
								)}
								aria-hidden="true"
							>
								{#if done}<Check class="size-4" />{:else}{i + 1}{/if}
							</span>
							{s.label}
						</button>
					</li>
				{/each}
			</ol>
		</nav>
	{/if}

	<section class="min-w-0 space-y-4" aria-labelledby="titre-etape">
		{#if !device.isDesktop}
			<div class="space-y-2">
				<p class="text-base text-muted-foreground">Étape {current + 1} sur {steps.length}</p>
				<div class="flex gap-1" aria-hidden="true">
					{#each steps as s, i (s.id)}
						<span class={cn('h-1.5 flex-1 rounded-full', i <= current ? 'bg-primary' : 'bg-muted')}></span>
					{/each}
				</div>
			</div>
		{/if}
		<h2 id="titre-etape" bind:this={heading} tabindex="-1" class="text-xl font-bold outline-none md:text-2xl">{steps[current].label}</h2>
		{#if savedNote}
			<p class="flex items-center gap-2 text-base text-muted-foreground" role="status">
				<CircleCheck class="size-4 text-primary" aria-hidden="true" />{savedNote}
			</p>
		{/if}

		{@render children()}

		<div
			class="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 border-t bg-background/95 p-3 backdrop-blur md:static md:border-0 md:bg-transparent md:p-0 md:pt-2 md:backdrop-blur-none"
		>
			<div class="mx-auto flex max-w-lg gap-2 md:mx-0 md:max-w-none md:justify-end">
				{#if current > 0}
					<Button variant="outline" size="lg" onclick={() => go(current - 1)} aria-label="Étape précédente">
						<ChevronLeft class="size-6" aria-hidden="true" /><span class="hidden md:inline">Précédent</span>
					</Button>
				{/if}
				{#if last}
					<Button size="lg" class="flex-1 md:flex-none" disabled={!canNext} onclick={onfinish} data-testid="terminer">
						<Check class="size-6" aria-hidden="true" />
						{finishLabel}
					</Button>
				{:else}
					<Button size="lg" class="flex-1 md:flex-none" disabled={!canNext} onclick={() => go(current + 1)} data-testid="etape-suivante">
						{nextLabel}
						<ChevronRight class="size-6" aria-hidden="true" />
					</Button>
				{/if}
			</div>
		</div>
	</section>
</div>
