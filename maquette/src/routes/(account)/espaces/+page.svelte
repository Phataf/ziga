<script lang="ts">
	/**
	 * Choix de l'espace (docs/UX.md §2) : une personne qui a plusieurs espaces choisit lequel ouvrir.
	 * Un écran de gestion n'affiche jamais deux organisations à la fois ; seuls les espaces personnels
	 * regroupent plusieurs organisations, en lecture seule.
	 */
	import { goto } from '$app/navigation';
	import { Building2, ChevronRight, House, KeyRound, Lock, ShieldCheck } from '@lucide/svelte';
	import { demo } from '$lib/demo.svelte';
	import { formatPhone } from '$lib/format';
	import type { SpaceChoice } from '$lib/portals';
	import type { ProfileId } from '$lib/profiles';

	const person = $derived(demo.person);
	const profileOf: Record<SpaceChoice['id'], ProfileId> = { owner: 'owner', tenant: 'tenant', landlord: 'landlord', member: 'manager' };
	const iconOf = { owner: Building2, tenant: KeyRound, landlord: House, member: Building2 };

	function choose(s: SpaceChoice) {
		demo.setProfile(profileOf[s.id]);
		goto(s.href);
	}
</script>

<div class="min-h-dvh bg-background">
	<main class="page-narrow space-y-6 py-8 md:py-16" data-testid="choix-espace">
		<div class="flex items-center gap-3">
			<span class="flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground" aria-hidden="true"><ShieldCheck class="size-6" /></span>
			<div>
				<h1 class="text-2xl font-bold md:text-3xl">Bonjour {person.civility} {person.name}</h1>
				<p class="text-base text-muted-foreground">{formatPhone(person.phone)}, vérifié par SMS</p>
			</div>
		</div>
		<h2 class="text-lg font-semibold">Quel espace voulez-vous ouvrir ?</h2>
		<ul class="space-y-3">
			{#each demo.spaces as s (s.id + (s.organizationId ?? ''))}
				{@const Icon = iconOf[s.id]}
				<li>
					<button type="button" class="flex min-h-20 w-full items-center gap-4 rounded-xl border-2 border-input bg-card p-4 text-left hover:border-primary hover:bg-accent" onclick={() => choose(s)} data-testid="espace-{s.id}">
						<span class="flex size-11 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground"><Icon class="size-6" aria-hidden="true" /></span>
						<span class="min-w-0 flex-1">
							<span class="block text-lg font-semibold">{s.label}</span>
							<span class="block text-base text-muted-foreground">{s.detail}</span>
						</span>
						<ChevronRight class="size-6 shrink-0 text-muted-foreground" aria-hidden="true" />
					</button>
				</li>
			{/each}
		</ul>
		<p class="flex items-start gap-2 text-base text-muted-foreground">
			<Lock class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			Chaque espace ne montre que ses propres données. « Mes logements » ne voit rien des biens confiés aux agences ; seul « Mon patrimoine » les regroupe, en lecture seule.
		</p>
	</main>
</div>
