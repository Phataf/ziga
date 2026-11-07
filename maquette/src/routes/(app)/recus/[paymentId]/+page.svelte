<script lang="ts">
	import { page } from '$app/state';
	import { CircleCheck, MessageCircle, Printer, Wallet } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import QrCode from '$lib/components/QrCode.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { demo } from '$lib/demo.svelte';
	import { formatDate, formatFCFA, formatMonth, formatPhone } from '$lib/format';
	import { methodLabel, paymentStatusLabel, paymentStatusVariant } from '$lib/labels';
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

<PageHeader title="Reçu" subtitle={payment?.receiptNumber} back="/encaissements" />

{#if !payment || !view}
	<p class="p-4">Reçu introuvable.</p>
{:else}
	<main class="mx-auto max-w-lg space-y-4 px-4 pt-3">
		{#if isNew}
			<p class="flex items-center gap-2 rounded-xl bg-success-soft p-3 font-semibold text-secondary-foreground" role="status">
				<CircleCheck class="size-6 shrink-0 text-primary" aria-hidden="true" />
				Encaissement enregistré
			</p>
		{/if}

		<article class="receipt space-y-3 rounded-xl border-2 border-dashed bg-white p-4 text-base" data-testid="recu">
			<header class="flex items-start justify-between gap-3 border-b pb-3">
				<div>
					<p class="text-lg font-bold">{demo.data.agency.name}</p>
					<p class="text-muted-foreground">{demo.data.agency.address}</p>
					<p class="text-muted-foreground">{formatPhone(demo.data.agency.phone)}</p>
				</div>
				<Badge variant={paymentStatusVariant[payment.status]}>{paymentStatusLabel[payment.status]}</Badge>
			</header>

			<div class="text-center">
				<p class="text-lg font-bold tracking-wide">REÇU DE LOYER{toReconcile ? ' PROVISOIRE' : ''}</p>
				<p>N° <strong data-testid="numero-recu">{payment.receiptNumber}</strong> du {formatDate(payment.date)}</p>
			</div>

			{#if toReconcile}
				<p class="rounded-lg bg-warning-soft p-2 text-center font-semibold text-warning-foreground">
					Paiement Mobile Money à rapprocher
				</p>
			{/if}

			<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
				<dt class="text-muted-foreground">Reçu de</dt>
				<dd class="font-medium">{view.tenant.civility} {view.tenant.name}</dd>
				<dt class="text-muted-foreground">Logement</dt>
				<dd>{view.property.name} — {view.unit.label}, {view.property.district}</dd>
				<dt class="text-muted-foreground">Moyen</dt>
				<dd>{methodLabel[payment.method]}{payment.reference ? ` — réf. ${payment.reference}` : ''}</dd>
				<dt class="text-muted-foreground">Période</dt>
				<dd>
					{#each payment.allocations as a (a.rentDueId)}
						<span class="block">{formatMonth(a.period)} : {formatFCFA(a.amount)}</span>
					{:else}
						Avance sur loyer
					{/each}
				</dd>
			</dl>

			<div class="flex items-center justify-between gap-3 border-t pt-3">
				<div>
					<p class="text-muted-foreground">Montant reçu</p>
					<p class="text-2xl font-bold" data-testid="montant-recu">{formatFCFA(payment.amount)}</p>
					<p class="text-muted-foreground">
						{view.balanceDue > 0 ? `Reste dû : ${formatFCFA(view.balanceDue)}` : 'Locataire à jour'}
					</p>
				</div>
				<div class="flex flex-col items-center gap-1">
					<QrCode value={url} size={104} />
					<span class="text-center text-base text-muted-foreground">Vérifier</span>
				</div>
			</div>
		</article>

		<div class="space-y-2 print:hidden">
			<Button href={whatsapp} target="_blank" rel="noopener" variant="whatsapp" size="lg" class="w-full" data-testid="envoyer-whatsapp">
				<MessageCircle class="size-6" aria-hidden="true" />
				Envoyer sur WhatsApp
			</Button>
			<div class="grid grid-cols-2 gap-2">
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
		.receipt {
			border: none;
		}
	}
</style>
