<script lang="ts">
	/**
	 * Reversements reçus par le propriétaire (lot 10 ter, étape 3b), tirés des relevés émis de chacun de ses
	 * gestionnaires ; une annulation (contre-écriture) apparaît en négatif. Téléphone et tablette : cartes ; ordinateur : tableau.
	 */
	import { onMount } from 'svelte';
	import { formatDate } from '@ziga/shared/dates';
	import { formatSignedFcfa } from '@ziga/shared/money';
	import { monthLabel } from '@ziga/shared/statements';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import RemoteState from '#lib/components/portals/RemoteState.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { payoutsOf, type OwnerStatement } from '#lib/portals/owner.ts';
	import { Remote } from '#lib/portals/remote.svelte.ts';

	const t = fr.ownerSpace;
	const methods = fr.statements.methods;
	const remote = new Remote<OwnerStatement[]>('/me/portal/owner/statements');
	onMount(() => void remote.load());
	const rows = $derived(payoutsOf(remote.data ?? []));
</script>

<PageHeader title={t.payoutsTitle} subtitle={t.payoutsSubtitle} />

<main class="page space-y-4 pt-3 pb-10" data-testid="reversements">
	<RemoteState {remote}>
		{#if !rows.length}
			<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground" data-testid="reversements-vide">{t.noPayout}</p>
		{:else if device.isDesktop}
			<div class="overflow-x-auto rounded-xl border bg-card">
				<table class="w-full text-left text-base">
					<thead class="border-b text-muted-foreground">
						<tr>
							<th class="px-4 py-3 font-medium">{t.payoutDate}</th>
							<th class="px-4 py-3 font-medium">{t.manager}</th>
							<th class="px-4 py-3 font-medium">{t.month}</th>
							<th class="px-4 py-3 font-medium">{t.method}</th>
							<th class="px-4 py-3 text-right font-medium">{t.amount}</th>
						</tr>
					</thead>
					<tbody class="divide-y">
						{#each rows as p (p.id)}
							<tr data-testid="reversement">
								<td class="px-4 py-3">{formatDate(p.paidOn)}</td>
								<td class="px-4 py-3">{p.organizationName}</td>
								<td class="px-4 py-3">{monthLabel(p.month)}</td>
								<td class="px-4 py-3">{methods[p.method] ?? p.method}</td>
								<td class="px-4 py-3 text-right font-semibold tabular-nums">
									{#if p.kind === 'reversal'}<Badge variant="danger">{t.reversal}</Badge>{/if}
									{formatSignedFcfa(p.signedAmount)}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<ul class="space-y-3">
				{#each rows as p (p.id)}
					<li class="space-y-1 rounded-xl border bg-card p-4" data-testid="reversement">
						<div class="flex flex-wrap items-baseline justify-between gap-2">
							<span class="font-semibold">{formatDate(p.paidOn)}</span>
							<span class="font-semibold tabular-nums">{formatSignedFcfa(p.signedAmount)}</span>
						</div>
						<p class="text-base break-words text-muted-foreground">
							{p.organizationName}&nbsp;· {t.forMonth(monthLabel(p.month))}&nbsp;· {methods[p.method] ?? p.method}
						</p>
						{#if p.kind === 'reversal'}<Badge variant="danger">{t.reversal}</Badge>{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</RemoteState>
</main>
