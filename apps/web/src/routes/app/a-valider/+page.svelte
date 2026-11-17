<script lang="ts">
	/**
	 * À valider et à rapprocher (lot 09) : espèces des agents de terrain « à valider », Mobile Money et virements « à
	 * rapprocher ». Validation unitaire ou groupée, en ligne ; le serveur impute et numérote le reçu.
	 */
	import { can } from '@ziga/shared/permissions';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import FeatureGate from '#lib/components/FeatureGate.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import PaymentsList from '#lib/components/payments/PaymentsList.svelte';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';

	const t = fr.payments;
</script>

<PageHeader title={t.toValidateTitle} subtitle={t.toValidateSubtitle} />

<main class="page pt-3 pb-10">
	{#if !can(organizations.active?.role, 'payment.read')}
		<FormAlert message={fr.app.notFound} />
	{:else}
		<FeatureGate key="payments.registry"><PaymentsList awaitingOnly /></FeatureGate>
	{/if}
</main>
