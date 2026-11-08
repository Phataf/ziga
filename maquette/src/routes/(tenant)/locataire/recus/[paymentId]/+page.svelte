<script lang="ts">
	import { page } from '$app/state';
	import { Printer } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import ReceiptDocument from '$lib/components/ReceiptDocument.svelte';
	import { Button } from '$lib/components/ui/button';
	import { demo } from '$lib/demo.svelte';
	import { leaseView } from '$lib/views';

	// Le reçu peut venir de n'importe quelle organisation où la personne a été locataire (lecture par portals).
	const lease = $derived(demo.tenantLeases.find((l) => l.payments.some((p) => p.id === page.params.paymentId)));
	const org = $derived(lease ? demo.orgs[lease.organization.id] : demo.data);
	const payment = $derived(lease?.payments.find((p) => p.id === page.params.paymentId));
	const view = $derived(payment ? leaseView(org, payment.leaseId) : undefined);
</script>

<PageHeader title="Reçu" subtitle={payment?.receiptNumber} back="/locataire/recus" backLabel="Mes reçus" />

{#if !payment || !view}
	<p class="p-4">Reçu introuvable.</p>
{:else}
	<main class="page-narrow space-y-3 pt-3">
		<ReceiptDocument {payment} {view} agency={org.agency} url="{page.url.origin}/recus/{payment.id}" />
		<Button variant="outline" class="w-full md:w-auto print:hidden" onclick={() => window.print()}><Printer aria-hidden="true" /> Imprimer ou enregistrer en PDF</Button>
	</main>
{/if}
