<script lang="ts">
	import { page } from '$app/state';
	import { CircleCheck, MessageCircle, Printer, Wallet } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import ReceiptDocument from '$lib/components/ReceiptDocument.svelte';
	import { Button } from '$lib/components/ui/button';
	import { demo } from '$lib/demo.svelte';
	import { leaseView } from '$lib/views';
	import { receiptMessage, waLink } from '$lib/whatsapp';

	const payment = $derived(demo.data.payments.find((p) => p.id === page.params.paymentId));
	const view = $derived(payment ? leaseView(demo.data, payment.leaseId) : undefined);
	const isNew = $derived(page.url.searchParams.has('nouveau'));
	const toReconcile = $derived(payment?.status === 'to_reconcile');
	const url = $derived(payment ? `${page.url.origin}/recus/${payment.id}` : '');

	const whatsapp = $derived(
		payment && view
			? waLink(
					view.tenant.phone,
					receiptMessage({
						civility: view.tenant.civility,
						name: view.tenant.name,
						amount: payment.amount,
						method: payment.method,
						date: payment.date,
						unitLabel: `${view.property.name} — ${view.unit.label}`,
						periods: payment.allocations.map((a) => a.period),
						receiptNumber: payment.receiptNumber,
						url,
						toReconcile,
						agency: demo.data.agency
					})
				)
			: ''
	);
</script>

<PageHeader title="Reçu" subtitle={payment?.receiptNumber} back="/encaissements" backLabel="Encaissements" />

{#if !payment || !view}
	<p class="p-4">Reçu introuvable.</p>
{:else}
	<main class="page space-y-4 pt-3 md:grid md:grid-cols-[minmax(0,32rem)_20rem] md:items-start md:justify-center md:gap-6 md:space-y-0">
		<div class="space-y-4">
		{#if isNew}
			<p class="flex items-center gap-2 rounded-xl bg-success-soft p-3 font-semibold text-secondary-foreground" role="status">
				<CircleCheck class="size-6 shrink-0 text-primary" aria-hidden="true" />
				Encaissement enregistré
			</p>
		{/if}

		<ReceiptDocument {payment} {view} agency={demo.data.agency} {url} />
		</div>

		<!-- Tablette et ordinateur : actions dans un panneau collant à droite du reçu. -->
		<div class="space-y-2 print:hidden md:sticky md:top-20 md:rounded-xl md:border md:bg-card md:p-4">
			<p class="hidden font-semibold md:block">Remettre le reçu</p>
			<Button href={whatsapp} target="_blank" rel="noopener" variant="whatsapp" size="lg" class="w-full" data-testid="envoyer-whatsapp">
				<MessageCircle class="size-6" aria-hidden="true" />
				Envoyer sur WhatsApp
			</Button>
			<div class="grid grid-cols-2 gap-2 md:grid-cols-1">
				<Button variant="outline" onclick={() => window.print()}>
					<Printer aria-hidden="true" /> Imprimer
				</Button>
				<Button variant="outline" href="/encaisser">
					<Wallet aria-hidden="true" /> Autre encaissement
				</Button>
			</div>
		</div>
	</main>
{/if}

<style>
	@media print {
		:global(nav),
		:global(header.sticky) {
			display: none !important;
		}
	}
</style>
