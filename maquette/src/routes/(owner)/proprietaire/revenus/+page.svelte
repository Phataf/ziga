<script lang="ts">
	/** Revenus du propriétaire, mois par mois et gestionnaire par gestionnaire (lecture seule). */
	import OrgTag from '$lib/components/OrgTag.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { demo } from '$lib/demo.svelte';
	import { device } from '$lib/device.svelte';
	import { formatFCFA, formatMonthTitle } from '$lib/format';
	import { lastPeriods } from '$lib/periods';

	const periods = $derived(lastPeriods(demo.today, 3).reverse());
	const groups = $derived(demo.portfolio(periods));
	const months = $derived(
		periods.map((period, i) => ({
			period,
			rows: groups.map((g) => ({ organization: g.organization, ...g.months[i] })),
			net: groups.reduce((s, g) => s + g.months[i].net, 0)
		}))
	);
</script>

<PageHeader title="Revenus" subtitle="Loyers encaissés, commissions, dépenses et net, par gestionnaire" />

<main class="page space-y-4 pt-3" data-testid="revenus-proprietaire">
	{#each months as m, i (m.period)}
		<section class="space-y-2" aria-labelledby="titre-mois-{m.period}">
			<div class="flex flex-wrap items-end justify-between gap-2">
				<h2 id="titre-mois-{m.period}" class="text-lg font-semibold">{formatMonthTitle(m.period)}{i === 0 ? ' (en cours)' : ''}</h2>
				<p class="text-base">Net : <strong class="text-xl text-primary tabular-nums" data-testid="net-mois">{formatFCFA(m.net)}</strong></p>
			</div>
			{#if device.isPhone}
				<ul class="space-y-2">
					{#each m.rows as r (r.organization.id)}
						<li class="space-y-2 rounded-xl border bg-card p-3">
							<OrgTag organization={r.organization} />
							<dl class="grid grid-cols-2 gap-1 text-base">
								<dt class="text-muted-foreground">Loyers encaissés</dt><dd class="text-right tabular-nums">{formatFCFA(r.received)}</dd>
								<dt class="text-muted-foreground">Commission</dt><dd class="text-right tabular-nums">− {formatFCFA(r.commission)}</dd>
								<dt class="text-muted-foreground">Dépenses</dt><dd class="text-right tabular-nums">− {formatFCFA(r.expenses)}</dd>
								<dt class="font-semibold">Net</dt><dd class="text-right font-semibold tabular-nums">{formatFCFA(r.net)}</dd>
							</dl>
						</li>
					{/each}
				</ul>
			{:else}
				<div class="overflow-x-auto rounded-xl border bg-card">
					<table class="data">
						<thead><tr><th>Gestionnaire</th><th class="text-right">Loyers encaissés</th><th class="text-right">Commission</th><th class="text-right">Dépenses</th><th class="text-right">Net</th></tr></thead>
						<tbody>
							{#each m.rows as r (r.organization.id)}
								<tr>
									<td><OrgTag organization={r.organization} /></td>
									<td class="text-right tabular-nums">{formatFCFA(r.received)}</td>
									<td class="text-right tabular-nums">− {formatFCFA(r.commission)}</td>
									<td class="text-right tabular-nums">− {formatFCFA(r.expenses)}</td>
									<td class="text-right font-semibold tabular-nums">{formatFCFA(r.net)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>
	{/each}
	<p class="text-base text-muted-foreground">Les montants viennent des relevés de chaque agence ; en gestion directe, il n’y a pas de commission.</p>
</main>
