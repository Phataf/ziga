<script lang="ts">
	/**
	 * Accueil (lot 10, docs/UX.md §4), lu sur l'appareil, différent par profil et par appareil : loyers attendus et
	 * encaissés du mois, taux d'encaissement, impayés, échéances du jour, relevés à émettre. Téléphone : carte des loyers,
	 * bouton Encaisser, carte des impayés, échéances du jour ; tablette : trois indicateurs, échéances en tableau ;
	 * ordinateur : quatre indicateurs, échéances en tableau, panneau des plus anciens retards. Agent de terrain : « Ma
	 * tournée » (retards et échéances du jour de ses unités).
	 */
	import { onMount } from 'svelte';
	import { Banknote, FileText, TriangleAlert, Wallet } from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import { formatDate, toIsoDate } from '@ziga/shared/dates';
	import { formatFcfa } from '@ziga/shared/money';
	import { can } from '@ziga/shared/permissions';
	import { addMonthsToMonth, monthLabel, monthOfDate } from '@ziga/shared/statements';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import ArrearsList from '#lib/components/collections/ArrearsList.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { latestByOwner, localArrears, localDashboard, ownersWithStatement, toStatement } from '#lib/collections/views.ts';
	import { device } from '#lib/device.svelte.ts';
	import { features } from '#lib/features/features.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';

	type Row = Record<string, unknown>;
	const t = fr.dashboard;
	const today = toIsoDate();
	const previousMonth = addMonthsToMonth(monthOfDate(today), -1);
	const role = $derived(organizations.active?.role);
	const landlord = $derived(organizations.active?.type === 'landlord');
	const agent = $derived(role === 'field_agent');
	const showStatements = $derived(!landlord && can(role, 'statement.read') && features.isEnabled('collections.owner_statements'));

	let dues = $state<Row[]>([]);
	let payments = $state<Row[]>([]);
	let tenants = $state<Row[]>([]);
	let units = $state<Row[]>([]);
	let mandates = $state<Row[]>([]);
	let statements = $state<Row[]>([]);
	let message = $state<string | null>(null);

	onMount(() => {
		if (organizations.active?.role === 'field_agent') return;
		const org = organizations.activeId;
		const onError = (error: Error) => (message = messageOf(error));
		const stops = [
			sync.watch<Row>(LOCAL_QUERIES.arrearsDues, [org], (r) => (dues = r), onError),
			sync.watch<Row>(LOCAL_QUERIES.confirmedRentPayments, [org], (r) => (payments = r), onError),
			sync.watch<Row>(LOCAL_QUERIES.tenants, [org], (r) => (tenants = r), onError),
			sync.watch<Row>(LOCAL_QUERIES.unitContexts, [org], (r) => (units = r), onError),
			sync.watch<Row>(LOCAL_QUERIES.mandates, [org], (r) => (mandates = r), onError),
			sync.watch<Row>(LOCAL_QUERIES.statements, [org], (r) => (statements = r), onError)
		];
		return () => stops.forEach((s) => s());
	});

	const toIssue = $derived.by(() => {
		if (!showStatements) return 0;
		const issued = latestByOwner(statements.map(toStatement), previousMonth);
		return ownersWithStatement(mandates, previousMonth).filter((o) => issued.get(o)?.status !== 'issued').length;
	});
	const summary = $derived(localDashboard(dues, payments, today, toIssue));
	const tenantName = $derived(new Map(tenants.map((x) => [String(x.id), String(x.full_name ?? '')])));
	const unitLabel = $derived(new Map(units.map((u) => [String(u.id), `${u.property_name} · ${u.label}`])));
	const dueRows = $derived(new Map(dues.map((d) => [String(d.id), d])));
	const oldest = $derived(
		device.isDesktop
			? localArrears({ dues, claims: [], tenants, awaiting: [], reminders: [], units, settings: null }, today).slice(0, 5)
			: []
	);
</script>

{#if agent}
	<PageHeader title={t.roundTitle} subtitle={t.roundHint} />
	<main class="page pt-3 pb-10"><ArrearsList round /></main>
{:else}
	<PageHeader title={landlord ? t.landlordTitle : t.title} subtitle={t.subtitle(monthLabel(summary.month))}>
		{#snippet actions()}
			{#if can(role, 'payment.record_cash') && !device.isPhone}
				<Button href={resolve('/app/encaisser')} size="lg"><Banknote class="size-5" aria-hidden="true" />{t.collect}</Button>
			{/if}
		{/snippet}
	</PageHeader>

	<main class="page space-y-4 pt-3 pb-10" data-testid="tableau-de-bord">
		<FormAlert {message} />
		<section class={device.isPhone ? 'space-y-3' : device.isDesktop ? 'grid grid-cols-4 gap-4' : 'grid grid-cols-3 gap-4'}>
			<article class="space-y-1 rounded-xl border bg-card p-4" data-testid="kpi-loyers">
				<p class="flex items-center gap-2 text-base text-muted-foreground"><Wallet class="size-5" aria-hidden="true" />{t.collected}</p>
				<p class="text-2xl font-bold tabular-nums">{formatFcfa(summary.collected)}</p>
				<p class="text-sm text-muted-foreground">{t.expected} : {formatFcfa(summary.expected)}</p>
			</article>
			<article class="space-y-1 rounded-xl border bg-card p-4" data-testid="kpi-taux">
				<p class="text-base text-muted-foreground">{t.rate}</p>
				<p class="text-2xl font-bold tabular-nums">{summary.collectionRate === null ? t.rateNone : `${summary.collectionRate} %`}</p>
			</article>
			{#if device.isPhone && can(role, 'payment.record_cash')}
				<Button href={resolve('/app/encaisser')} size="lg" class="w-full"><Banknote class="size-5" aria-hidden="true" />{t.collect}</Button>
			{/if}
			<a href={resolve('/app/impayes')} class="block space-y-1 rounded-xl border bg-card p-4 hover:bg-accent" data-testid="kpi-impayes">
				<p class="flex items-center gap-2 text-base text-muted-foreground">
					<TriangleAlert class="size-5" aria-hidden="true" />{t.arrears}
				</p>
				<p class="text-2xl font-bold tabular-nums">{formatFcfa(summary.arrears)}</p>
				<p class="text-sm text-muted-foreground">{t.arrearsCount(summary.arrearsCount)}</p>
			</a>
			{#if showStatements && (device.isDesktop || device.isPhone)}
				<a href={resolve('/app/releves')} class="block space-y-1 rounded-xl border bg-card p-4 hover:bg-accent" data-testid="kpi-releves">
					<p class="flex items-center gap-2 text-base text-muted-foreground">
						<FileText class="size-5" aria-hidden="true" />{t.statementsToIssue}
					</p>
					<p class="text-2xl font-bold tabular-nums">{summary.statementsToIssue}</p>
					<p class="text-sm text-muted-foreground">{t.statementsToIssueCount(summary.statementsToIssue)}</p>
				</a>
			{/if}
		</section>

		<div class={device.isDesktop ? 'grid grid-cols-3 gap-4' : 'space-y-4'}>
			<section class={device.isDesktop ? 'col-span-2 space-y-2' : 'space-y-2'} data-testid="echeances-du-jour">
				<h2 class="text-lg font-semibold">{t.dueToday}</h2>
				{#if !summary.dueToday.length}
					<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground">{t.dueTodayEmpty}</p>
				{:else if device.isPhone}
					<ul class="space-y-2">
						{#each summary.dueToday as d (d.id)}
							{@const row = dueRows.get(d.id)}
							<li class="rounded-xl border bg-card p-4">
								<p class="font-semibold break-words">{tenantName.get(String(row?.tenant_id)) ?? ''}</p>
								<p class="text-sm text-muted-foreground">{unitLabel.get(String(row?.unit_id)) ?? ''}</p>
								<p class="tabular-nums">{formatFcfa(d.amountDue - d.amountPaid)}</p>
							</li>
						{/each}
					</ul>
				{:else}
					<div class="overflow-x-auto rounded-xl border bg-card">
						<table class="w-full text-left text-base">
							<thead class="border-b text-muted-foreground">
								<tr>
									<th class="px-4 py-3 font-medium">{t.columns.tenant}</th>
									<th class="px-4 py-3 font-medium">{t.columns.unit}</th>
									<th class="px-4 py-3 font-medium">{t.columns.due}</th>
									<th class="px-4 py-3 text-right font-medium">{t.columns.amount}</th>
								</tr>
							</thead>
							<tbody class="divide-y">
								{#each summary.dueToday as d (d.id)}
									{@const row = dueRows.get(d.id)}
									<tr>
										<td class="px-4 py-3">{tenantName.get(String(row?.tenant_id)) ?? ''}</td>
										<td class="px-4 py-3">{unitLabel.get(String(row?.unit_id)) ?? ''}</td>
										<td class="px-4 py-3 tabular-nums">{formatDate(d.dueOn)}</td>
										<td class="px-4 py-3 text-right tabular-nums">{formatFcfa(d.amountDue - d.amountPaid)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</section>
			{#if device.isDesktop}
				<aside class="space-y-2" data-testid="plus-anciens-retards">
					<h2 class="text-lg font-semibold">{t.oldest}</h2>
					{#if !oldest.length}
						<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground">{fr.arrears.empty}</p>
					{:else}
						<ul class="divide-y rounded-xl border bg-card">
							{#each oldest as g (g.tenantId)}
								<li class="flex items-center justify-between gap-2 p-3">
									<span class="min-w-0">
										<span class="block font-medium break-words">{g.tenantName}</span>
										<span class="block text-sm text-muted-foreground">{fr.arrears.daysLate(g.daysLate)}</span>
									</span>
									<span class="tabular-nums">{formatFcfa(g.total)}</span>
								</li>
							{/each}
						</ul>
						<Button variant="outline" href={resolve('/app/impayes')} class="w-full">{t.seeArrears}</Button>
					{/if}
				</aside>
			{/if}
		</div>
	</main>
{/if}
