<script lang="ts">
	/**
	 * Sélecteur « Voir en tant que », propre à la maquette : il permet de parcourir l'application
	 * avec chaque profil pendant les entretiens. Dans le produit, le profil découle du compte.
	 */
	import { goto } from '$app/navigation';
	import { ArrowLeftRight, ChevronsUpDown, CircleCheck, Eye, RotateCcw } from '@lucide/svelte';
	import { Sheet } from '$lib/components/ui/sheet';
	import { demo } from '$lib/demo.svelte';
	import { profileGroups, profiles, type ProfileId } from '$lib/profiles';
	import { cn } from '$lib/utils';
	import Avatar from './Avatar.svelte';

	let { variant = 'strip' }: { variant?: 'strip' | 'sidebar' | 'rail' } = $props();

	let open = $state(false);
	let confirmReset = $state(false);

	function choose(id: ProfileId) {
		demo.setProfile(id);
		open = false;
		goto(profiles[id].home);
	}

	function reset() {
		demo.reset();
		confirmReset = false;
		open = false;
		goto(demo.profile.home);
	}
</script>

{#if variant === 'strip'}
	<button
		type="button"
		class="flex min-h-11 w-full items-center justify-center gap-2 bg-foreground px-3 text-base text-background"
		onclick={() => (open = true)}
		data-testid="choisir-profil"
	>
		<Eye class="size-[18px]" aria-hidden="true" />
		<span>Démo · <strong>{demo.profile.label}</strong></span>
		<ChevronsUpDown class="size-4 opacity-70" aria-hidden="true" />
	</button>
{:else if variant === 'rail'}
	<button
		type="button"
		class="flex w-full flex-col items-center gap-1 rounded-xl px-1 py-2 text-sm text-muted-foreground hover:bg-accent"
		onclick={() => (open = true)}
		aria-label="Changer de profil (actuel : {demo.profile.label})"
		data-testid="choisir-profil"
	>
		<Avatar name={demo.profile.label} />
		<span class="leading-tight">Profil</span>
	</button>
{:else}
	<button
		type="button"
		class="flex w-full items-center gap-3 rounded-xl border bg-card p-2.5 text-left hover:bg-accent"
		onclick={() => (open = true)}
		data-testid="choisir-profil"
	>
		<Avatar name={demo.profile.label} />
		<span class="min-w-0 flex-1">
			<span class="block truncate font-semibold">{demo.profile.label}</span>
			<span class="block truncate text-sm text-muted-foreground">Démo · changer de profil</span>
		</span>
		<ChevronsUpDown class="size-[18px] shrink-0 text-muted-foreground" aria-hidden="true" />
	</button>
{/if}

<Sheet bind:open labelledby="titre-profil">
	<div class="space-y-4">
		<div class="pr-10">
			<h2 id="titre-profil" class="text-xl font-bold">Voir l’application en tant que…</h2>
			<p class="text-base text-muted-foreground">Chaque profil a son espace, sa navigation et ses données.</p>
		</div>
		<a href="/espaces" class="flex min-h-12 items-center gap-3 rounded-xl border-2 border-dashed border-input px-3 hover:bg-accent" onclick={() => (open = false)}>
			<ArrowLeftRight class="size-5 shrink-0 text-primary" aria-hidden="true" />
			<span><span class="block font-semibold">Choix de l’espace</span><span class="block text-base text-muted-foreground">Issouf Sawadogo : propriétaire et bailleur particulier</span></span>
		</a>
		{#each profileGroups as g (g.label)}
			<section class="space-y-2" aria-label={g.label}>
				<h3 class="text-sm font-semibold tracking-wide text-muted-foreground uppercase">{g.label}</h3>
				<ul class="space-y-2">
					{#each g.ids as id (id)}
						{@const p = profiles[id]}
						{@const active = demo.profileId === id}
						<li>
							<button
								type="button"
								class={cn(
									'flex min-h-14 w-full items-center gap-3 rounded-xl border-2 px-3 py-2 text-left',
									active ? 'border-primary bg-secondary' : 'border-input bg-card hover:bg-accent'
								)}
								aria-pressed={active}
								onclick={() => choose(id)}
							>
								<Avatar name={p.label} />
								<span class="min-w-0 flex-1">
									<span class="block font-semibold">{p.label}</span>
									<span class="block text-base text-muted-foreground">{p.description}</span>
								</span>
								{#if active}<CircleCheck class="size-6 shrink-0 text-primary" aria-hidden="true" />{/if}
							</button>
						</li>
					{/each}
				</ul>
			</section>
		{/each}
		<div class="border-t pt-3">
			{#if confirmReset}
				<div class="space-y-2" role="alertdialog" aria-labelledby="titre-raz">
					<p id="titre-raz" class="font-medium">Effacer toutes les saisies faites pendant la démo ?</p>
					<div class="grid grid-cols-2 gap-2">
						<button type="button" class="min-h-11 rounded-lg border-2 border-input font-semibold" onclick={() => (confirmReset = false)}>Annuler</button>
						<button type="button" class="min-h-11 rounded-lg bg-destructive font-semibold text-destructive-foreground" onclick={reset}>Effacer</button>
					</div>
				</div>
			{:else}
				<button type="button" class="flex min-h-11 items-center gap-2 text-base text-muted-foreground hover:text-foreground" onclick={() => (confirmReset = true)}>
					<RotateCcw class="size-[18px]" aria-hidden="true" /> Effacer les saisies de la démo
				</button>
			{/if}
		</div>
	</div>
</Sheet>
