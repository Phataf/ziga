<script lang="ts">
	/**
	 * Reçu de paiement affiché (lot 09) : le même contenu que le PDF (receiptDocument, packages/shared), dans l'ordre des
	 * mentions retenues. « Reçu provisoire » sans numéro définitif, « ANNULÉ » une fois annulé. Imprimable tel quel
	 * (styles d'impression : seul le reçu sort sur le papier).
	 */
	import type { ReceiptDocument } from '@ziga/shared/receipts';
	import { fr } from '#lib/i18n/fr.ts';
	import QrCode from './QrCode.svelte';

	let { document: doc }: { document: ReceiptDocument } = $props();
</script>

<article
	class="receipt-print relative mx-auto w-full max-w-md overflow-hidden rounded-xl border bg-white p-5 text-black shadow-sm"
	data-testid="recu"
	data-cancelled={doc.cancelled ? '1' : undefined}
>
	{#if doc.cancelled}
		<span
			class="pointer-events-none absolute inset-0 flex items-center justify-center text-6xl font-bold text-red-700/15 select-none"
			style="transform: rotate(-35deg)"
			aria-hidden="true">ANNULÉ</span
		>
	{/if}
	<header class="space-y-0.5 text-center">
		{#each doc.organization as line, i (i)}
			<p class={i === 0 ? 'text-lg font-semibold break-words' : 'text-sm break-words text-neutral-700'}>{line}</p>
		{/each}
	</header>
	<div class="my-4 space-y-1 text-center">
		<h2 class="text-xl font-bold" data-testid="titre-recu">{doc.title}</h2>
		{#if doc.cancelled}<p class="text-lg font-bold text-red-700" data-testid="mention-annule">ANNULÉ</p>{/if}
		<p class="font-semibold tabular-nums" data-testid="numero-recu">N° {doc.number}</p>
		<p class="text-sm text-neutral-700">Émis le {doc.issuedOn}</p>
	</div>
	<dl class="space-y-2 text-base">
		{#each doc.fields as field (field.label)}
			<div class="grid grid-cols-[minmax(7rem,35%)_1fr] gap-2">
				<dt class="text-sm font-medium text-neutral-600">{field.label}</dt>
				<dd class={field.label === 'Montant' ? 'text-lg font-bold tabular-nums' : 'break-words'}>
					{#each Array.isArray(field.value) ? field.value : [field.value] as v, i (i)}<span class="block">{v}</span>{/each}
				</dd>
			</div>
		{/each}
		<div class="grid grid-cols-[minmax(7rem,35%)_1fr] gap-2">
			<dt class="text-sm font-medium text-neutral-600">En lettres</dt>
			<dd class="italic">{doc.amountInWords}</dd>
		</div>
	</dl>
	{#if doc.verificationUrl}
		<div class="mt-4 flex flex-col items-center gap-1">
			<QrCode value={doc.verificationUrl} label={fr.payments.verifyQr} />
			<p class="text-center text-sm break-all text-neutral-600">{fr.payments.verifyQr} : {doc.verificationUrl}</p>
		</div>
	{/if}
</article>

<style>
	@media print {
		:global(body *) {
			visibility: hidden;
		}
		.receipt-print,
		.receipt-print :global(*) {
			visibility: visible;
		}
		.receipt-print {
			position: absolute;
			inset: 0 auto auto 0;
			box-shadow: none;
			border: none;
		}
	}
</style>
