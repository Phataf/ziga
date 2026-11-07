<script lang="ts">
	/** Reçu de loyer : même document pour l'agence (à remettre) et pour le locataire (à consulter). */
	import QrCode from '$lib/components/QrCode.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { formatDate, formatFCFA, formatMonth, formatPhone } from '$lib/format';
	import { methodLabel, paymentStatusLabel, paymentStatusVariant } from '$lib/labels';
	import type { Agency, Payment } from '$lib/types';
	import type { LeaseView } from '$lib/views';

	let { payment, view, agency, url }: { payment: Payment; view: LeaseView; agency: Agency; url: string } = $props();
	const toReconcile = $derived(payment.status === 'to_reconcile');
	const toValidate = $derived(payment.status === 'to_validate');
</script>

<article class="receipt space-y-3 rounded-xl border-2 border-dashed bg-white p-4 text-base" data-testid="recu">
	<header class="flex items-start justify-between gap-3 border-b pb-3">
		<div>
			<p class="text-lg font-bold">{agency.name}</p>
			<p class="text-muted-foreground">{agency.address}</p>
			<p class="text-muted-foreground">{formatPhone(agency.phone)}</p>
		</div>
		<Badge variant={paymentStatusVariant[payment.status]}>{paymentStatusLabel[payment.status]}</Badge>
	</header>

	<div class="text-center">
		<p class="text-lg font-bold tracking-wide">REÇU DE LOYER{toReconcile || toValidate ? ' PROVISOIRE' : ''}</p>
		<p>N° <strong data-testid="numero-recu">{payment.receiptNumber}</strong> du {formatDate(payment.date)}</p>
	</div>

	{#if toReconcile}
		<p class="rounded-lg bg-warning-soft p-2 text-center font-semibold text-warning-foreground">
			Paiement Mobile Money à rapprocher
		</p>
	{:else if toValidate}
		<p class="rounded-lg bg-info-soft p-2 text-center font-semibold text-info-foreground">Espèces à valider par le gestionnaire</p>
	{/if}

	<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
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

<style>
	@media print {
		.receipt {
			border: none;
		}
	}
</style>
