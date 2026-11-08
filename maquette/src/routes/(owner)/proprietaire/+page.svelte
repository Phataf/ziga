<script lang="ts">
	/**
	 * Mon patrimoine (D13) : tous les biens de la personne, regroupés par gestionnaire
	 * (deux agences et la gestion directe). Lecture seule, une organisation à la fois (portals.ts).
	 */
	import { Building2, ChevronRight, House, Lock, MapPin, TrendingUp, Wallet } from '@lucide/svelte';
	import OrgTag from '$lib/components/OrgTag.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import UnitStatusBadge from '$lib/components/status/UnitStatusBadge.svelte';
	import * as Card from '$lib/components/ui/card';
	import { demo } from '$lib/demo.svelte';
	import { formatFCFA, formatMonth, formatMonthTitle } from '$lib/format';
	import { lastPeriods, ofMonth } from '$lib/periods';
	import { cn } from '$lib/utils';

	const periods = $derived(lastPeriods(demo.today, 2));
	const groups = $derived(demo.portfolio(periods));
	let filter = $state<string>('all');
	const shown = $derived(filter === 'all' ? groups : groups.filter((g) => g.organization.id === filter));

	const units = $derived(groups.flatMap((g) => g.properties.flatMap((p) => p.units)));
	const rented = $derived(units.filter((u) => u.lease).length);
	const lastNet = $derived(groups.reduce((s, g) => s + g.months[0].net, 0));
	const thisMonth = $derived(groups.reduce((s, g) => s + g.months[1].received, 0));
	const person = $derived(demo.ownerPerson);
</script>

<PageHeader title="Bonjour {person.civility} {person.name}" subtitle="Tous vos biens, quel que soit le gestionnaire" />

<main class="page space-y-5 pt-3 md:space-y-6" data-testid="espace-proprietaire">
	<section class="grid grid-cols-1 gap-3 md:grid-cols-3" aria-label="Vos revenus">
		<Card.Root class="border-primary/30 bg-success-soft">
			<Card.Content class="space-y-1">
				<p class="text-base text-secondary-foreground">Net {ofMonth(periods[0], formatMonth)}, tous gestionnaires</p>
				<p class="text-3xl font-bold text-primary" data-testid="net-proprietaire">{formatFCFA(lastNet)}</p>
				<p class="text-base text-muted-foreground">après commissions et dépenses</p>
			</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Content class="space-y-1">
				<p class="flex items-center gap-2 text-base text-muted-foreground"><TrendingUp class="size-[18px]" aria-hidden="true" /> {formatMonthTitle(periods[1])}, en cours</p>
				<p class="text-2xl font-bold">{formatFCFA(thisMonth)}</p>
				<p class="text-base text-muted-foreground">de loyers déjà encaissés</p>
			</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Content class="space-y-1">
				<p class="flex items-center gap-2 text-base text-muted-foreground"><Building2 class="size-[18px]" aria-hidden="true" /> Occupation</p>
				<p class="text-2xl font-bold" data-testid="occupation">{rented} / {units.length}</p>
				<p class="text-base text-muted-foreground">logements loués, chez {groups.length} gestionnaires</p>
			</Card.Content>
		</Card.Root>
	</section>

	<div class="flex gap-2 overflow-x-auto" role="group" aria-label="Filtrer par gestionnaire">
		{#each [{ id: 'all', label: 'Tous' }, ...groups.map((g) => ({ id: g.organization.id, label: g.managedBy === 'self' ? 'Gestion directe' : g.organization.name }))] as f (f.id)}
			<button
				type="button"
				class={cn('min-h-11 shrink-0 rounded-full border-2 px-4 font-medium whitespace-nowrap', filter === f.id ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card hover:bg-accent')}
				aria-pressed={filter === f.id}
				onclick={() => (filter = f.id)}
			>
				{f.label}
			</button>
		{/each}
	</div>

	{#each shown as g (g.organization.id)}
		<section class="space-y-3" aria-labelledby="titre-{g.organization.id}" data-testid="gestionnaire">
			<div class="flex flex-wrap items-end justify-between gap-2">
				<div>
					<h2 id="titre-{g.organization.id}" class="flex items-center gap-2 text-lg font-semibold">
						{#if g.managedBy === 'self'}<House class="size-5" aria-hidden="true" /> Gestion directe{:else}<Building2 class="size-5" aria-hidden="true" /> {g.organization.name}{/if}
					</h2>
					<p class="text-base text-muted-foreground">
						{g.managedBy === 'self' ? 'Vous gérez vous-même, sans commission' : `Agence sous mandat · commission ${g.properties[0]?.commissionRate ?? 0} %`}
					</p>
				</div>
				<p class="flex items-center gap-2 text-base"><Wallet class="size-4" aria-hidden="true" /> Net {ofMonth(periods[0], formatMonth)} : <strong class="tabular-nums">{formatFCFA(g.months[0].net)}</strong></p>
			</div>
			<ul class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
				{#each g.properties as p (p.id)}
					<li>
						<a href="/proprietaire/biens/{g.organization.id}/{p.id}" class="block h-full space-y-3 rounded-xl border bg-card p-4 hover:bg-accent" data-testid="bien-proprietaire">
							<div class="flex items-start justify-between gap-2">
								<div class="min-w-0">
									<p class="truncate font-semibold">{p.name}</p>
									<p class="flex items-center gap-1 text-base text-muted-foreground"><MapPin class="size-4 shrink-0" aria-hidden="true" />{p.district}, {p.city}</p>
								</div>
								<ChevronRight class="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
							</div>
							<OrgTag organization={g.organization} />
							<ul class="space-y-2">
								{#each p.units as u (u.id)}
									<li class="flex flex-wrap items-center justify-between gap-2">
										<span>{u.label} · {formatFCFA(u.rent)}</span>
										<UnitStatusBadge summary={u.summary} />
									</li>
								{/each}
							</ul>
						</a>
					</li>
				{/each}
			</ul>
		</section>
	{/each}

	<p class="flex items-start gap-2 text-base text-muted-foreground">
		<Lock class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
		Vous seul voyez cet ensemble. Chaque agence ne voit que les biens qu’elle gère, et jamais ceux confiés à une autre.
	</p>
</main>
