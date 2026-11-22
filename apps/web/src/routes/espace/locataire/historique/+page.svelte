<script lang="ts">
	/**
	 * Historique (lot 10 ter, étape 3c) : une chronologie unique de ses baux, échéances, reçus et cautions, toutes agences
	 * confondues, chaque élément avec son organisation ; par pages (curseur du serveur, « Voir plus »).
	 */
	import { onMount } from 'svelte';
	import { CalendarClock, KeyRound, Receipt, ShieldCheck } from '@lucide/svelte';
	import { formatDate } from '@ziga/shared/dates';
	import { formatFcfa } from '@ziga/shared/money';
	import { monthLabel, type StatementMonth } from '@ziga/shared/statements';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { HistoryPages } from '#lib/portals/remote.svelte.ts';
	import { placeLabel, type HistoryItem } from '#lib/portals/tenant.ts';

	const t = fr.tenantSpace;
	const pages = new HistoryPages();
	onMount(() => void pages.load());

	const str = (v: unknown) => (typeof v === 'string' ? v : null);
	const num = (v: unknown) => (typeof v === 'number' ? v : 0);
	const icons = { lease: KeyRound, rent_due: CalendarClock, receipt: Receipt, deposit: ShieldCheck };

	function title(i: HistoryItem): string {
		if (i.kind === 'lease') return t.kinds.lease(placeLabel({ unitLabel: str(i.unitLabel), propertyName: str(i.propertyName) }));
		if (i.kind === 'rent_due') return t.kinds.rent_due(monthLabel(String(i.periodStart).slice(0, 7) as StatementMonth));
		if (i.kind === 'receipt') return t.kinds.receipt(str(i.number) ?? t.provisional);
		return t.kinds.deposit;
	}

	function detail(i: HistoryItem): string {
		if (i.kind === 'lease') return fr.leases.status[String(i.status)] ?? String(i.status);
		if (i.kind === 'rent_due') return `${formatFcfa(num(i.amountDue))} · ${t.dueStatus[String(i.status)] ?? String(i.status)}`;
		if (i.kind === 'receipt') return `${formatFcfa(num(i.amount))} · ${t.paidOn(formatDate(String(i.paidOn)))}`;
		return formatFcfa(num(i.agreedAmount));
	}
</script>

<PageHeader title={t.historyTitle} subtitle={t.historySubtitle} />

<main class="page space-y-4 pt-3 pb-10" data-testid="historique">
	{#if pages.loading && !pages.loaded}
		<p class="text-base text-muted-foreground" role="status">{fr.ownerSpace.loading}</p>
	{:else}
		<FormAlert message={pages.error} />
		{#if pages.loaded && !pages.items.length}
			<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground" data-testid="historique-vide">{t.noHistory}</p>
		{:else}
			<ol class="space-y-3">
				{#each pages.items as i (i.organizationId + i.kind + i.id)}
					{@const Icon = icons[i.kind]}
					<li class="flex gap-3 rounded-xl border bg-card p-4" data-testid="element-historique" data-kind={i.kind}>
						<Icon class="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
						<div class="min-w-0 flex-1 space-y-1">
							<div class="flex flex-wrap items-baseline justify-between gap-2">
								<span class="font-semibold break-words">{title(i)}</span>
								<span class="text-base text-muted-foreground">{formatDate(i.date)}</span>
							</div>
							<p class="text-base break-words">{detail(i)}</p>
							<p class="flex flex-wrap items-center gap-2 text-base text-muted-foreground">
								<span class="break-words" data-testid="organisation-element">{i.organizationName}</span>
								{#if i.kind === 'receipt' && i.status === 'cancelled'}<Badge variant="danger">{t.receiptCancelled}</Badge>{/if}
							</p>
						</div>
					</li>
				{/each}
			</ol>
			{#if pages.next}
				<Button variant="outline" onclick={() => pages.load(true)} disabled={pages.loading} data-testid="historique-plus">{t.more}</Button>
			{/if}
		{/if}
	{/if}
</main>
