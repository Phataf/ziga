<script lang="ts">
	/**
	 * Encaissements (lot 09) : liste lue sur l'appareil, bouton « Encaisser » ; l'agent de terrain voit les loyers de ses
	 * unités. Validation groupée des espèces « à valider » sur tablette et ordinateur (docs/UX.md §4).
	 */
	import { Plus } from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import { can } from '@ziga/shared/permissions';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import FeatureGate from '#lib/components/FeatureGate.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import PaymentsList from '#lib/components/payments/PaymentsList.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';

	const t = fr.payments;
	const role = $derived(organizations.active?.role);
</script>

<PageHeader title={role === 'field_agent' ? t.titleMine : t.title} subtitle={t.subtitle}>
	{#snippet actions()}
		{#if can(role, 'payment.record_cash')}
			<Button href={resolve('/app/encaisser')} size="lg" data-testid="encaisser"
				><Plus class="size-5" aria-hidden="true" />{t.collect}</Button
			>
		{/if}
	{/snippet}
</PageHeader>

<main class="page pt-3 pb-10" data-testid="encaissements">
	{#if !can(role, 'payment.read')}
		<FormAlert message={fr.app.notFound} />
	{:else}
		<FeatureGate key="payments.registry"><PaymentsList /></FeatureGate>
	{/if}
</main>
