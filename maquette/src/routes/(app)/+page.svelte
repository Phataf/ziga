<script lang="ts">
	import { ArrowRight, Building2, CalendarClock, ChevronRight, CircleAlert, ClipboardCheck, Wallet } from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { demo } from '$lib/demo.svelte';
	import { device } from '$lib/device.svelte';
	import { formatDate, formatDays, formatFCFA, formatMonth } from '$lib/format';
	import { arrears, monthStats } from '$lib/views';

	const stats = $derived(monthStats(demo.data));
	const ratio = $derived(stats.expected ? Math.min(100, Math.round((stats.collected / stats.expected) * 100)) : 0);
	const late = $derived(arrears(demo.data));
	const pending = $derived(demo.data.payments.filter((p) => p.status !== 'validated'));
	const occupied = $derived(demo.data.units.filter((u) => u.status === 'rented').length);
	const occupancy = $derived(demo.data.units.length ? Math.round((occupied / demo.data.units.length) * 100) : 0);
	const isAgent = $derived(demo.profileId === 'field_agent');
	const greeting = $derived(isAgent ? 'Ma tournée du jour' : demo.profileId === 'landlord' ? 'Mes logements' : demo.workspaceName);
</script>

<!-- Téléphone : une colonne, l'essentiel en haut, l'action principale sous le pouce. -->
{#if device.isPhone}
<div>
	<header class="bg-primary px-4 pt-5 pb-16 text-primary-foreground">
		<div class="mx-auto max-w-lg">
			<p class="text-base opacity-90">Aujourd’hui, {formatDate(demo.today)}</p>
			<h1 class="text-2xl font-bold">{greeting}</h1>
		</div>
	</header>

	<main class="mx-auto -mt-12 max-w-lg space-y-4 px-4">
		<Card.Root data-testid="carte-loyers">
			<Card.Content class="space-y-3">
				<p class="text-base font-medium text-muted-foreground">Loyers de {formatMonth(stats.period)}</p>
				<div>
					<p class="text-base text-muted-foreground">Encaissés</p>
					<p class="text-3xl font-bold text-primary" data-testid="encaisse-mois">{formatFCFA(stats.collected)}</p>
					<p class="text-base text-muted-foreground">
						sur <span class="font-semibold text-foreground" data-testid="attendu-mois">{formatFCFA(stats.expected)}</span> attendus
					</p>
				</div>
				<div
					class="h-3 overflow-hidden rounded-full bg-muted"
					role="progressbar"
					aria-valuenow={ratio}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-label="Part des loyers encaissés"
				>
					<div class="h-full rounded-full bg-primary transition-all" style:width="{ratio}%"></div>
				</div>
				<p class="text-base text-muted-foreground">{ratio} % du mois encaissé</p>
			</Card.Content>
		</Card.Root>

		<Button href="/encaisser" size="lg" class="w-full text-xl">
			<Wallet class="size-6" aria-hidden="true" />
			Encaisser un loyer
		</Button>

		{#if pending.length && !isAgent}
			<a href="/encaissements?filtre=a_valider" class="flex min-h-14 items-center gap-3 rounded-xl border bg-info-soft p-3 text-info-foreground">
				<ClipboardCheck class="size-6 shrink-0" aria-hidden="true" />
				<span class="flex-1 font-medium">{pending.length} encaissement{pending.length > 1 ? 's' : ''} à contrôler</span>
				<ChevronRight class="size-5" aria-hidden="true" />
			</a>
		{/if}

		<a href="/impayes" class="block" data-testid="carte-impayes">
			<Card.Root class="border-destructive/30 bg-danger-soft">
				<Card.Content class="flex items-center gap-3">
					<CircleAlert class="size-8 shrink-0 text-destructive" aria-hidden="true" />
					<div class="flex-1">
						<p class="text-lg font-semibold text-destructive">
							{stats.arrearsCount} impayé{stats.arrearsCount > 1 ? 's' : ''}
						</p>
						<p class="text-base">{formatFCFA(stats.arrearsAmount)} en retard</p>
					</div>
					<span class="flex items-center text-base font-medium text-destructive">
						Voir <ChevronRight class="size-5" aria-hidden="true" />
					</span>
				</Card.Content>
			</Card.Root>
		</a>

		<section aria-labelledby="titre-jour" class="space-y-2">
			<h2 id="titre-jour" class="flex items-center gap-2 text-lg font-semibold">
				<CalendarClock class="size-5" aria-hidden="true" /> Échéances du jour
			</h2>
			{#if stats.dueToday.length === 0}
				<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground">Aucune échéance aujourd’hui.</p>
			{:else}
				<ul class="space-y-2" data-testid="echeances-du-jour">
					{#each stats.dueToday as v (v.lease.id)}
						<li>
							<a href="/encaisser/{v.lease.id}" class="flex min-h-16 items-center gap-3 rounded-xl border bg-card p-3 hover:bg-accent">
								<div class="min-w-0 flex-1">
									<p class="truncate font-semibold">{v.tenant.civility} {v.tenant.name}</p>
									<p class="truncate text-base text-muted-foreground">{v.property.name} — {v.unit.label}</p>
								</div>
								<div class="text-right">
									<p class="font-semibold">{formatFCFA(v.balanceDue)}</p>
									<p class="text-base text-primary">Encaisser</p>
								</div>
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	</main>
</div>

{:else}
<!-- Tablette et ordinateur : tableau de bord en grille, indicateurs côte à côte, panneaux de travail. -->
<main class="page space-y-6 pt-6" data-testid="tableau-de-bord">
	<div class="flex flex-wrap items-end justify-between gap-4">
		<div>
			<p class="text-base text-muted-foreground">{device.isDesktop ? `Loyers de ${formatMonth(stats.period)}` : `Aujourd’hui, ${formatDate(demo.today)} · loyers de ${formatMonth(stats.period)}`}</p>
			<h1 class="text-2xl font-bold xl:text-3xl">{greeting}</h1>
		</div>
		<div class="flex gap-2 xl:hidden">
			<Button href="/encaisser"><Wallet aria-hidden="true" /> Encaisser un loyer</Button>
		</div>
	</div>

	<section class="grid grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-4" aria-label="Indicateurs du mois">
		<Card.Root class="md:col-span-3 xl:col-span-1">
			<Card.Content class="space-y-2">
				<p class="text-base text-muted-foreground">Encaissés</p>
				<p class="text-3xl font-bold text-primary" data-testid="encaisse-mois-bureau">{formatFCFA(stats.collected)}</p>
				<div class="h-2.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={ratio} aria-valuemin={0} aria-valuemax={100} aria-label="Part des loyers encaissés">
					<div class="h-full rounded-full bg-primary" style:width="{ratio}%"></div>
				</div>
				<p class="text-base text-muted-foreground">{ratio} % de {formatFCFA(stats.expected)} attendus</p>
			</Card.Content>
		</Card.Root>
		<a href="/impayes" class="block rounded-xl focus-visible:outline-offset-4">
			<Card.Root class="h-full border-destructive/30 hover:bg-danger-soft">
				<Card.Content class="space-y-2">
					<p class="flex items-center gap-2 text-base text-muted-foreground"><CircleAlert class="size-[18px] text-destructive" aria-hidden="true" /> Impayés</p>
					<p class="text-3xl font-bold text-destructive">{formatFCFA(stats.arrearsAmount)}</p>
					<p class="text-base text-muted-foreground">{stats.arrearsCount} locataire{stats.arrearsCount > 1 ? 's' : ''} en retard</p>
				</Card.Content>
			</Card.Root>
		</a>
		<a href="/encaissements?filtre=a_valider" class="block rounded-xl focus-visible:outline-offset-4">
			<Card.Root class="h-full hover:bg-accent">
				<Card.Content class="space-y-2">
					<p class="flex items-center gap-2 text-base text-muted-foreground"><ClipboardCheck class="size-[18px] text-info-foreground" aria-hidden="true" /> {isAgent ? 'En attente de validation' : 'À contrôler'}</p>
					<p class="text-3xl font-bold">{pending.length}</p>
					<p class="text-base text-muted-foreground">à rapprocher ou à valider</p>
				</Card.Content>
			</Card.Root>
		</a>
		<a href="/biens" class="block rounded-xl focus-visible:outline-offset-4">
			<Card.Root class="h-full hover:bg-accent">
				<Card.Content class="space-y-2">
					<p class="flex items-center gap-2 text-base text-muted-foreground"><Building2 class="size-[18px] text-primary" aria-hidden="true" /> Occupation</p>
					<p class="text-3xl font-bold">{occupancy} %</p>
					<p class="text-base text-muted-foreground">{occupied} unités louées sur {demo.data.units.length}</p>
				</Card.Content>
			</Card.Root>
		</a>
	</section>

	<div class="grid grid-cols-1 gap-6 xl:grid-cols-3">
		<section class="overflow-hidden rounded-xl border bg-card xl:col-span-2" aria-labelledby="titre-jour-bureau">
			<div class="flex items-center justify-between gap-2 border-b px-4 py-3">
				<h2 id="titre-jour-bureau" class="flex items-center gap-2 text-lg font-semibold">
					<CalendarClock class="size-5" aria-hidden="true" /> Échéances du jour
				</h2>
				<Badge variant="secondary">{stats.dueToday.length}</Badge>
			</div>
			{#if stats.dueToday.length === 0}
				<p class="p-4 text-muted-foreground">Aucune échéance aujourd’hui.</p>
			{:else}
				<table class="data" data-testid="echeances-du-jour-bureau">
					<thead><tr><th>Locataire</th><th>Logement</th><th class="text-right">Montant</th><th><span class="sr-only">Action</span></th></tr></thead>
					<tbody>
						{#each stats.dueToday as v (v.lease.id)}
							<tr>
								<td class="font-semibold">{v.tenant.civility} {v.tenant.name}</td>
								<td class="text-muted-foreground">{v.property.name} — {v.unit.label}</td>
								<td class="text-right font-semibold tabular-nums">{formatFCFA(v.balanceDue)}</td>
								<td class="w-1 text-right"><Button variant="outline" href="/encaisser/{v.lease.id}">Encaisser</Button></td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</section>

		<section class="rounded-xl border bg-card" aria-labelledby="titre-retards">
			<div class="flex items-center justify-between gap-2 border-b px-4 py-3">
				<h2 id="titre-retards" class="text-lg font-semibold">Plus anciens retards</h2>
				<a href="/impayes" class="flex items-center gap-1 text-base text-primary hover:underline">Tout voir <ArrowRight class="size-4" aria-hidden="true" /></a>
			</div>
			<ul class="divide-y">
				{#each late.slice(0, 5) as v (v.lease.id)}
					<li class="flex items-center gap-3 px-4 py-3">
						<div class="min-w-0 flex-1">
							<p class="truncate font-medium">{v.tenant.civility} {v.tenant.name}</p>
							<p class="truncate text-base text-muted-foreground">{formatDays(v.maxLateDays)} · {v.property.name}</p>
						</div>
						<span class="font-semibold text-destructive tabular-nums">{formatFCFA(v.overdueAmount)}</span>
					</li>
				{:else}
					<li class="px-4 py-6 text-muted-foreground">Aucun retard.</li>
				{/each}
			</ul>
		</section>
	</div>
</main>
{/if}
