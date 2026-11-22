<script lang="ts">
	/**
	 * Reçus (lot 10 ter, étape 3c) : tous ses reçus, quelle que soit l'agence, y compris ceux d'une agence quittée (le
	 * lien vers la fiche reste lié) ; PDF par lien signé de 5 minutes, chaque téléchargement journalisé dans l'organisation.
	 * Un reçu annulé reste visible avec la mention « ANNULÉ » (règle 3). Lu dans l'historique, par pages.
	 */
	import { onMount } from 'svelte';
	import { Download } from '@lucide/svelte';
	import { formatDate } from '@ziga/shared/dates';
	import { formatFcfa } from '@ziga/shared/money';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { HistoryPages, openSigned } from '#lib/portals/remote.svelte.ts';
	import { receiptsOf, type HistoryReceipt } from '#lib/portals/tenant.ts';

	const t = fr.tenantSpace;
	const purposes = fr.payments.purposes;
	const pages = new HistoryPages();
	onMount(() => void pages.load());
	const receipts = $derived(receiptsOf(pages.items));
	let message = $state<string | null>(null);
	let busy = $state(false);

	async function pdf(r: HistoryReceipt) {
		message = null;
		busy = true;
		try {
			await openSigned(`/me/portal/tenant/receipts/${r.organizationId}/${r.id}/pdf`);
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}
</script>

{#snippet number(r: HistoryReceipt)}
	<span class="font-semibold">{r.number ?? t.provisional}</span>
	{#if r.status === 'cancelled'}<Badge variant="danger" data-testid="recu-annule">{t.receiptCancelled}</Badge>{/if}
{/snippet}

{#snippet action(r: HistoryReceipt)}
	{#if r.hasPdf}
		<Button variant="outline" onclick={() => pdf(r)} disabled={busy} data-testid="recu-pdf">
			<Download class="size-5" aria-hidden="true" />{t.receiptPdf}
		</Button>
	{:else}
		<span class="text-base text-muted-foreground">{t.receiptPdfPending}</span>
	{/if}
{/snippet}

<PageHeader title={t.receiptsTitle} subtitle={t.receiptsSubtitle} />

<main class="page space-y-4 pt-3 pb-10" data-testid="recus-locataire">
	<FormAlert message={message ?? pages.error} />
	{#if pages.loading && !pages.loaded}
		<p class="text-base text-muted-foreground" role="status">{fr.ownerSpace.loading}</p>
	{:else if !receipts.length && !pages.next}
		<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground" data-testid="recus-vide">{t.noReceipt}</p>
	{:else if device.isDesktop}
		<div class="overflow-x-auto rounded-xl border bg-card">
			<table class="w-full text-left text-base">
				<thead class="border-b text-muted-foreground">
					<tr>
						<th class="px-4 py-3 font-medium">{fr.payments.columns.date}</th>
						<th class="px-4 py-3 font-medium">{fr.ownerSpace.document}</th>
						<th class="px-4 py-3 font-medium">{fr.payments.columns.purpose}</th>
						<th class="px-4 py-3 font-medium">{fr.ownerSpace.manager}</th>
						<th class="px-4 py-3 text-right font-medium">{fr.payments.columns.amount}</th>
						<th class="px-4 py-3"><span class="sr-only">{t.receiptPdf}</span></th>
					</tr>
				</thead>
				<tbody class="divide-y">
					{#each receipts as r (r.organizationId + r.id)}
						<tr data-testid="recu-locataire" data-organisation={r.organizationName}>
							<td class="px-4 py-3">{formatDate(r.paidOn)}</td>
							<td class="px-4 py-3"><span class="flex flex-wrap items-center gap-2">{@render number(r)}</span></td>
							<td class="px-4 py-3">{purposes[r.purpose] ?? r.purpose}</td>
							<td class="px-4 py-3">{r.organizationName}</td>
							<td class="px-4 py-3 text-right tabular-nums">{formatFcfa(r.amount)}</td>
							<td class="px-4 py-3 text-right">{@render action(r)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<ul class="space-y-3">
			{#each receipts as r (r.organizationId + r.id)}
				<li class="space-y-2 rounded-xl border bg-card p-4" data-testid="recu-locataire" data-organisation={r.organizationName}>
					<div class="flex flex-wrap items-center justify-between gap-2">
						<span class="flex flex-wrap items-center gap-2">{@render number(r)}</span>
						<span class="font-semibold tabular-nums">{formatFcfa(r.amount)}</span>
					</div>
					<p class="text-base break-words text-muted-foreground">
						{purposes[r.purpose] ?? r.purpose}&nbsp;· {t.paidOn(formatDate(r.paidOn))}&nbsp;· {r.organizationName}
					</p>
					{@render action(r)}
				</li>
			{/each}
		</ul>
	{/if}
	{#if pages.next}
		<Button variant="outline" onclick={() => pages.load(true)} disabled={pages.loading} data-testid="recus-plus">{t.more}</Button>
	{/if}
</main>
