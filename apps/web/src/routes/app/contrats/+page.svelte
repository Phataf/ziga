<script lang="ts">
	/**
	 * Contrats (lot 08 bis, docs/UX.md §10) : un bail par ligne, avec le statut de son contrat et ses alertes, lus sur
	 * l'appareil sans appel réseau. Filtres par statut du bail, statut du contrat, alertes. Cartes sur téléphone et
	 * tablette, tableau sur ordinateur. Direction et gestion seulement : les autres rôles ne reçoivent aucun contrat.
	 */
	import { onMount } from 'svelte';
	import { FileCog } from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import { formatDate, toIsoDate } from '@ziga/shared/dates';
	import { LEASE_STATUSES, type LeaseStatus } from '@ziga/shared/leases';
	import { can } from '@ziga/shared/permissions';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { contractTone, alertTone } from '#lib/contracts/tones.ts';
	import {
		contractList,
		DEFAULT_CONTRACT_FILTERS,
		filterContracts,
		toContract,
		type ContractFilters,
		type LeaseContractState
	} from '#lib/contracts/views.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';

	type Row = Record<string, unknown>;
	const t = fr.contracts;
	const today = toIsoDate();
	const role = $derived(organizations.active?.role);
	const allowed = $derived(can(role, 'contract.read'));
	const select = 'min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 text-base';
	const CONTRACT_STATES: LeaseContractState[] = ['none', 'draft', 'in_review', 'ready_to_sign', 'signed'];

	let leaseRows = $state<Row[]>([]);
	let contractRows = $state<Row[]>([]);
	let filters = $state<ContractFilters>({ ...DEFAULT_CONTRACT_FILTERS });
	let message = $state<string | null>(null);

	onMount(() => {
		if (!allowed) return;
		const org = organizations.activeId;
		const onError = (error: Error) => (message = messageOf(error));
		const stops = [
			sync.watch<Row>(LOCAL_QUERIES.contractLeases, [org], (rows) => (leaseRows = rows), onError),
			sync.watch<Row>(LOCAL_QUERIES.contracts, [org], (rows) => (contractRows = rows), onError)
		];
		return () => stops.forEach((stop) => stop());
	});

	const leaseVersion = $derived(new Map(leaseRows.map((r) => [String(r.id), Number(r.version ?? 1)])));
	const items = $derived(
		contractList(
			leaseRows.map((r) => ({
				id: String(r.id),
				status: String(r.status) as LeaseStatus,
				startsOn: String(r.starts_on ?? ''),
				endsOn: r.ends_on ? String(r.ends_on) : null,
				noticeGivenOn: r.notice_given_on ? String(r.notice_given_on) : null,
				lastAutomaticRenewalOn: r.last_renewal_automatic && r.last_renewed_on ? String(r.last_renewed_on) : null,
				unitLabel: String(r.unit_label ?? ''),
				tenantName: String(r.tenant_name ?? '')
			})),
			contractRows.map((r) =>
				toContract(r, {
					leaseVersion: leaseVersion.get(String(r.lease_id)) ?? null,
					frozenLeaseVersion:
						r.frozen_lease_version === null || r.frozen_lease_version === undefined ? null : Number(r.frozen_lease_version),
					recordedByName: null,
					today
				})
			),
			today
		)
	);
	const shown = $derived(filterContracts(items, filters));
	const period = (start: string, end: string | null) => t.period(formatDate(start), end ? formatDate(end) : null);
</script>

<PageHeader title={t.title} subtitle={t.subtitle}>
	{#snippet actions()}
		{#if can(role, 'contract_template.read')}
			<Button variant="outline" href={resolve('/app/contrats/modeles')} data-testid="lien-modeles"
				><FileCog aria-hidden="true" />{t.templatesLink}</Button
			>
		{/if}
	{/snippet}
</PageHeader>

<main class="page space-y-4 pt-3 pb-10" data-testid="contrats">
	{#if !allowed}
		<FormAlert message={t.noAccess} />
	{:else}
		<FormAlert {message} />
		<div class="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="filtres">
			<div class="space-y-1">
				<label for="filtre-bail" class="block font-medium">{t.filterLease}</label>
				<select id="filtre-bail" class={select} bind:value={filters.leaseStatus} data-testid="filtre-bail">
					<option value="all">{t.filterAll}</option>
					{#each LEASE_STATUSES.filter((s) => s !== 'cancelled') as s (s)}<option value={s}>{fr.leases.status[s]}</option>{/each}
				</select>
			</div>
			<div class="space-y-1">
				<label for="filtre-contrat" class="block font-medium">{t.filterContract}</label>
				<select id="filtre-contrat" class={select} bind:value={filters.contractState} data-testid="filtre-contrat">
					<option value="all">{t.filterAll}</option>
					{#each CONTRACT_STATES as s (s)}<option value={s}>{t.status[s]}</option>{/each}
				</select>
			</div>
			<label class="flex min-h-12 items-center gap-3 self-end text-base">
				<input type="checkbox" class="size-5" bind:checked={filters.alertsOnly} data-testid="filtre-alertes" />
				{t.alertsOnly}
			</label>
		</div>

		{#if !items.length}
			<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground">{t.empty}</p>
		{:else if !shown.length}
			<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground">{t.noResult}</p>
		{:else if device.isDesktop}
			<div class="relative overflow-x-auto rounded-xl border bg-card">
				<table class="w-full text-left text-base">
					<thead class="border-b text-muted-foreground">
						<tr>
							<th class="px-4 py-3 font-medium">{t.lease}</th>
							<th class="px-4 py-3 font-medium">{fr.leases.tenant}</th>
							<th class="px-4 py-3 font-medium">{t.filterLease}</th>
							<th class="px-4 py-3 font-medium">{t.contract}</th>
							<th class="px-4 py-3 font-medium">{t.alertsColumn}</th>
						</tr>
					</thead>
					<tbody class="divide-y">
						{#each shown as i (i.leaseId)}
							<tr data-testid="ligne-contrat" data-bail={i.leaseId} data-etat={i.state}>
								<td class="px-4 py-3">
									<a
										class="font-medium underline-offset-2 hover:underline"
										href={i.contract ? resolve('/app/contrats/[id]', { id: i.contract.id }) : resolve('/app/baux/[id]', { id: i.leaseId })}
										>{i.unitLabel}</a
									>
									<span class="block text-sm text-muted-foreground">{period(i.startsOn, i.endsOn)}</span>
								</td>
								<td class="px-4 py-3">{i.tenantName}</td>
								<td class="px-4 py-3"><Badge variant="secondary">{fr.leases.status[i.leaseStatus]}</Badge></td>
								<td class="px-4 py-3"><Badge variant={contractTone(i.state)} data-testid="statut-contrat">{t.status[i.state]}</Badge></td>
								<td class="px-4 py-3">
									<span class="flex flex-wrap gap-1">
										{#each i.alerts as a (a)}<Badge variant={alertTone(a)} data-testid="alerte">{t.alerts[a]}</Badge>{/each}
									</span>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<ul class="space-y-3">
				{#each shown as i (i.leaseId)}
					<li data-testid="ligne-contrat" data-bail={i.leaseId} data-etat={i.state}>
						<a
							class="block space-y-2 rounded-xl border bg-card p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
							href={i.contract ? resolve('/app/contrats/[id]', { id: i.contract.id }) : resolve('/app/baux/[id]', { id: i.leaseId })}
						>
							<span class="flex flex-wrap items-center justify-between gap-2">
								<span class="font-semibold break-words">{i.unitLabel}</span>
								<Badge variant={contractTone(i.state)} data-testid="statut-contrat">{t.status[i.state]}</Badge>
							</span>
							<span class="block text-base break-words">{i.tenantName}</span>
							<span class="block text-sm text-muted-foreground">{fr.leases.status[i.leaseStatus]} · {period(i.startsOn, i.endsOn)}</span>
							{#if i.alerts.length}
								<span class="flex flex-wrap gap-1">
									{#each i.alerts as a (a)}<Badge variant={alertTone(a)} data-testid="alerte">{t.alerts[a]}</Badge>{/each}
								</span>
							{/if}
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</main>
