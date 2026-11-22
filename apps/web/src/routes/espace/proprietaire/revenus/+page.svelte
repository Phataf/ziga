<script lang="ts">
	/**
	 * Revenus du propriétaire (lot 10 ter, étape 3b) : par mois et par bien, sur les douze derniers mois, d'après les
	 * relevés émis de chaque gestionnaire ; rendement = net ÷ encaissé (décision du porteur), calculé par
	 * `packages/shared/portals`. Téléphone et tablette : cartes ; ordinateur : tableaux.
	 */
	import { onMount } from 'svelte';
	import { formatFcfa, formatSignedFcfa } from '@ziga/shared/money';
	import type { IncomeMonth, IncomeProperty } from '@ziga/shared/portals';
	import { monthLabel } from '@ziga/shared/statements';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import RemoteState from '#lib/components/portals/RemoteState.svelte';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { formatYield, incomeByMonth, propertiesByYield, propertyNames, type OwnerAssetsOrganization } from '#lib/portals/owner.ts';
	import { Remote } from '#lib/portals/remote.svelte.ts';

	const t = fr.ownerSpace;
	const income = new Remote<{ months: IncomeMonth[]; properties: IncomeProperty[] }>('/me/portal/owner/income');
	const assets = new Remote<{ organizations: OwnerAssetsOrganization[] }>('/me/portal/owner/assets');
	onMount(() => void Promise.all([income.load(), assets.load()]));

	const months = $derived(incomeByMonth(income.data?.months ?? []));
	const names = $derived(propertyNames(assets.data?.organizations ?? []));
	const properties = $derived(propertiesByYield(income.data?.properties ?? []));
	const yieldOf = (p: IncomeProperty) => (p.yieldPercent === null ? t.yieldNone : formatYield(p.yieldPercent));
</script>

<PageHeader title={t.incomeTitle} subtitle={t.incomeSubtitle} />

<main class="page space-y-6 pt-3 pb-10" data-testid="revenus">
	<RemoteState remote={income}>
		{#if !months.length}
			<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground" data-testid="revenus-vide">{t.noIncome}</p>
		{:else}
			<section class="space-y-3" aria-labelledby="revenus-mois">
				<h2 id="revenus-mois" class="text-lg font-semibold">{t.byMonth}</h2>
				{#if device.isDesktop}
					<div class="overflow-x-auto rounded-xl border bg-card">
						<table class="w-full text-left text-base">
							<thead class="border-b text-muted-foreground">
								<tr>
									<th class="px-4 py-3 font-medium">{t.month}</th>
									<th class="px-4 py-3 text-right font-medium">{t.collected}</th>
									<th class="px-4 py-3 text-right font-medium">{t.commission}</th>
									<th class="px-4 py-3 text-right font-medium">{t.expenses}</th>
									<th class="px-4 py-3 text-right font-medium">{t.net}</th>
									<th class="px-4 py-3 text-right font-medium">{t.paidOut}</th>
								</tr>
							</thead>
							<tbody class="divide-y">
								{#each months as m (m.month)}
									<tr data-testid="revenu-mois">
										<td class="px-4 py-3">{monthLabel(m.month)}</td>
										<td class="px-4 py-3 text-right tabular-nums">{formatFcfa(m.collected)}</td>
										<td class="px-4 py-3 text-right tabular-nums">{formatFcfa(m.commission)}</td>
										<td class="px-4 py-3 text-right tabular-nums">{formatFcfa(m.expenses)}</td>
										<td class="px-4 py-3 text-right font-semibold tabular-nums">{formatSignedFcfa(m.net)}</td>
										<td class="px-4 py-3 text-right tabular-nums">{formatFcfa(m.paidOut)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{:else}
					<ul class="space-y-3">
						{#each months as m (m.month)}
							<li class="space-y-2 rounded-xl border bg-card p-4" data-testid="revenu-mois">
								<div class="flex flex-wrap items-baseline justify-between gap-2">
									<span class="font-semibold">{monthLabel(m.month)}</span>
									<span class="font-semibold tabular-nums">{formatSignedFcfa(m.net)}</span>
								</div>
								<dl class="grid grid-cols-2 gap-x-4 gap-y-1 text-base">
									<dt class="text-muted-foreground">{t.collected}</dt>
									<dd class="text-right tabular-nums">{formatFcfa(m.collected)}</dd>
									<dt class="text-muted-foreground">{t.commission}</dt>
									<dd class="text-right tabular-nums">{formatFcfa(m.commission)}</dd>
									<dt class="text-muted-foreground">{t.expenses}</dt>
									<dd class="text-right tabular-nums">{formatFcfa(m.expenses)}</dd>
									<dt class="text-muted-foreground">{t.paidOut}</dt>
									<dd class="text-right tabular-nums">{formatFcfa(m.paidOut)}</dd>
								</dl>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<section class="space-y-3" aria-labelledby="revenus-biens">
				<h2 id="revenus-biens" class="text-lg font-semibold">{t.byProperty}</h2>
				<p class="text-base text-muted-foreground">{t.yieldHelp}</p>
				{#if device.isDesktop}
					<div class="overflow-x-auto rounded-xl border bg-card">
						<table class="w-full text-left text-base">
							<thead class="border-b text-muted-foreground">
								<tr>
									<th class="px-4 py-3 font-medium">{t.property}</th>
									<th class="px-4 py-3 text-right font-medium">{t.collected}</th>
									<th class="px-4 py-3 text-right font-medium">{t.net}</th>
									<th class="px-4 py-3 text-right font-medium">{t.yield}</th>
								</tr>
							</thead>
							<tbody class="divide-y">
								{#each properties as p (p.organizationId + p.propertyId)}
									<tr data-testid="revenu-bien">
										<td class="px-4 py-3">{names.get(p.propertyId) ?? ''}</td>
										<td class="px-4 py-3 text-right tabular-nums">{formatFcfa(p.collected)}</td>
										<td class="px-4 py-3 text-right tabular-nums">{formatSignedFcfa(p.net)}</td>
										<td class="px-4 py-3 text-right font-semibold tabular-nums" data-testid="rendement">{yieldOf(p)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{:else}
					<ul class="space-y-3">
						{#each properties as p (p.organizationId + p.propertyId)}
							<li class="space-y-1 rounded-xl border bg-card p-4" data-testid="revenu-bien">
								<div class="flex flex-wrap items-baseline justify-between gap-2">
									<span class="font-semibold break-words">{names.get(p.propertyId) ?? ''}</span>
									<span class="font-semibold tabular-nums" data-testid="rendement">{yieldOf(p)}</span>
								</div>
								<p class="text-base text-muted-foreground tabular-nums">
									{t.collected}
									{formatFcfa(p.collected)} · {t.net}
									{formatSignedFcfa(p.net)}
								</p>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}
	</RemoteState>
</main>
