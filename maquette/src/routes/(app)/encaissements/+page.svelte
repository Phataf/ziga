<script lang="ts">
	import { page } from '$app/state';
	import { Check, ChevronRight, CircleAlert, Download, Eye, Printer, Wallet } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { ActionMenu } from '$lib/components/ui/menu';
	import { demo } from '$lib/demo.svelte';
	import { device } from '$lib/device.svelte';
	import { formatDate, formatFCFA, formatMonthTitle } from '$lib/format';
	import { methodLabel, paymentStatusLabel, paymentStatusVariant } from '$lib/labels';
	import type { PaymentStatus } from '$lib/types';
	import { cn } from '$lib/utils';
	import { leaseView, monthStats, paymentsOfMonth } from '$lib/views';

	type Filter = 'all' | PaymentStatus;
	const fromUrl = page.url.searchParams.get('filtre');
	let filter = $state<Filter>(fromUrl === 'a_valider' ? 'to_validate' : fromUrl === 'a_rapprocher' ? 'to_reconcile' : 'all');
	let selected = $state<string[]>([]);

	const stats = $derived(monthStats(demo.data));
	const all = $derived(paymentsOfMonth(demo.data));
	const payments = $derived(filter === 'all' ? all : all.filter((p) => p.status === filter));
	const count = (s: PaymentStatus) => all.filter((p) => p.status === s).length;
	const canValidate = $derived(demo.profileId === 'director' || demo.profileId === 'manager');
	const selectable = $derived(payments.filter((p) => p.status === 'to_validate'));
	const title = $derived(demo.profileId === 'landlord' ? 'Loyers reçus' : demo.profileId === 'field_agent' ? 'Mes encaissements' : 'Encaissements');

	const filters = $derived<{ id: Filter; label: string; n: number }[]>([
		{ id: 'all', label: 'Tous', n: all.length },
		{ id: 'to_reconcile', label: 'À rapprocher', n: count('to_reconcile') },
		{ id: 'to_validate', label: 'À valider', n: count('to_validate') },
		{ id: 'validated', label: 'Validés', n: count('validated') }
	]);

	function validateSelected() {
		for (const id of selected) demo.validate(id);
		selected = [];
	}
</script>

<PageHeader {title} subtitle={formatMonthTitle(stats.period)}>
	{#snippet actions()}
		<div class="hidden gap-2 md:flex">
			<Button variant="outline" disabled title="Selon la formule (exports.csv)"><Download aria-hidden="true" /> Exporter</Button>
			<Button href="/encaisser"><Wallet aria-hidden="true" /> Encaisser un loyer</Button>
		</div>
	{/snippet}
</PageHeader>

<main class="page space-y-4 pt-3">
	<Button href="/encaisser" size="lg" class="w-full text-xl md:hidden">
		<Wallet class="size-6" aria-hidden="true" /> Encaisser un loyer
	</Button>

	<div class="grid grid-cols-1 gap-3 md:grid-cols-3">
		<a href="/impayes" class="block md:order-3">
			<Card.Root class="h-full border-destructive/30 bg-danger-soft">
				<Card.Content class="flex items-center gap-3">
					<CircleAlert class="size-7 shrink-0 text-destructive" aria-hidden="true" />
					<div class="flex-1">
						<p class="font-semibold text-destructive">Impayés : {stats.arrearsCount}</p>
						<p class="text-base">{formatFCFA(stats.arrearsAmount)} en retard</p>
					</div>
					<ChevronRight class="size-6 text-destructive" aria-hidden="true" />
				</Card.Content>
			</Card.Root>
		</a>
		<Card.Root>
			<Card.Content class="p-3 md:p-4">
				<p class="text-base text-muted-foreground">Encaissé ce mois</p>
				<p class="text-lg font-bold md:text-2xl">{formatFCFA(stats.collected)}</p>
			</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Content class="p-3 md:p-4">
				<p class="text-base text-muted-foreground">À contrôler</p>
				<p class="text-lg font-bold md:text-2xl">{count('to_reconcile') + count('to_validate')} paiement{count('to_reconcile') + count('to_validate') > 1 ? 's' : ''}</p>
			</Card.Content>
		</Card.Root>
	</div>

	<div class="flex flex-wrap items-center gap-2" role="group" aria-label="Filtrer par statut">
		{#each filters as f (f.id)}
			<button
				type="button"
				class={cn(
					'min-h-11 rounded-full border-2 px-4 font-medium whitespace-nowrap',
					filter === f.id ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card hover:bg-accent'
				)}
				aria-pressed={filter === f.id}
				onclick={() => {
					filter = f.id;
					selected = [];
				}}
			>
				{f.label} <span class="opacity-75">({f.n})</span>
			</button>
		{/each}
	</div>

	<!-- Téléphone : liste compacte, une ligne par paiement, le reçu en un toucher. -->
	{#if device.isPhone}
	<section class="space-y-2" aria-labelledby="titre-liste">
		<h2 id="titre-liste" class="text-lg font-semibold">Derniers encaissements</h2>
		<ul class="divide-y rounded-xl border bg-card" data-testid="liste-encaissements">
			{#each payments as p (p.id)}
				{@const v = leaseView(demo.data, p.leaseId)!}
				<li class="flex items-center">
					<a href="/recus/{p.id}" class="flex min-h-16 min-w-0 flex-1 items-center gap-3 p-3 hover:bg-accent">
						<div class="min-w-0 flex-1">
							<p class="truncate font-semibold">{v.tenant.civility} {v.tenant.name}</p>
							<p class="truncate text-base text-muted-foreground">{formatDate(p.date)} · {methodLabel[p.method]}</p>
						</div>
						<div class="flex shrink-0 flex-col items-end gap-1">
							<span class="font-semibold">{formatFCFA(p.amount)}</span>
							<Badge variant={paymentStatusVariant[p.status]}>{paymentStatusLabel[p.status]}</Badge>
						</div>
					</a>
					{#if canValidate && p.status === 'to_validate'}
						<Button variant="outline" class="mr-3" onclick={() => demo.validate(p.id)} aria-label="Valider l’encaissement de {v.tenant.name}">
							<Check aria-hidden="true" />
						</Button>
					{/if}
				</li>
			{:else}
				<li class="p-4 text-muted-foreground">Aucun encaissement.</li>
			{/each}
		</ul>
	</section>

	{:else}
	<!-- Tablette et ordinateur : tableau, sélection multiple et validation groupée. -->
	<section class="overflow-hidden rounded-xl border bg-card" aria-labelledby="titre-tableau">
		<div class="flex min-h-14 items-center justify-between gap-3 border-b px-4">
			<h2 id="titre-tableau" class="text-lg font-semibold">{payments.length} encaissement{payments.length > 1 ? 's' : ''}</h2>
			{#if canValidate && selected.length}
				<Button onclick={validateSelected}><Check aria-hidden="true" /> Valider la sélection ({selected.length})</Button>
			{/if}
		</div>
		<div class="overflow-x-auto">
			<table class="data" data-testid="tableau-encaissements">
				<thead>
					<tr>
						{#if canValidate && selectable.length}
							<th class="w-1">
								<input
									type="checkbox"
									class="size-5 accent-[var(--color-primary)]"
									aria-label="Tout sélectionner"
									checked={selected.length === selectable.length}
									onchange={(e) => (selected = e.currentTarget.checked ? selectable.map((p) => p.id) : [])}
								/>
							</th>
						{/if}
						<th>Date</th>
						<th class="hidden lg:table-cell">Reçu</th>
						<th>Locataire</th>
						<th class="hidden xl:table-cell">Logement</th>
						<th>Moyen</th>
						<th class="text-right">Montant</th>
						<th>Statut</th>
						<th><span class="sr-only">Actions</span></th>
					</tr>
				</thead>
				<tbody>
					{#each payments as p (p.id)}
						{@const v = leaseView(demo.data, p.leaseId)!}
						<tr>
							{#if canValidate && selectable.length}
								<td>
									{#if p.status === 'to_validate'}
										<input type="checkbox" class="size-5 accent-[var(--color-primary)]" value={p.id} bind:group={selected} aria-label="Sélectionner {v.tenant.name}" />
									{/if}
								</td>
							{/if}
							<td class="whitespace-nowrap tabular-nums">{formatDate(p.date)}</td>
							<td class="hidden whitespace-nowrap text-muted-foreground tabular-nums lg:table-cell">{p.receiptNumber}</td>
							<td class="font-semibold">{v.tenant.civility} {v.tenant.name}</td>
							<td class="hidden text-muted-foreground xl:table-cell">{v.property.name} — {v.unit.label}</td>
							<td class="whitespace-nowrap">{methodLabel[p.method]}</td>
							<td class="text-right font-semibold whitespace-nowrap tabular-nums">{formatFCFA(p.amount)}</td>
							<td><Badge variant={paymentStatusVariant[p.status]}>{paymentStatusLabel[p.status]}</Badge></td>
							<td class="w-1 text-right">
								<ActionMenu
									label="Actions pour le reçu {p.receiptNumber}"
									actions={[
										{ label: 'Voir le reçu', icon: Eye, href: `/recus/${p.id}` },
										{ label: 'Imprimer', icon: Printer, href: `/recus/${p.id}` },
										...(canValidate && p.status === 'to_validate' ? [{ label: 'Valider', icon: Check, onclick: () => demo.validate(p.id) }] : [])
									]}
								/>
							</td>
						</tr>
					{:else}
						<tr><td colspan="9" class="py-8 text-center text-muted-foreground">Aucun encaissement.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
	{/if}
</main>
