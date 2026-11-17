<script lang="ts">
	/**
	 * Impayés (lot 10) : locataires en retard, groupés et triés par ancienneté, lus sur l'appareil ; relance par WhatsApp
	 * (lien pré-rempli, enregistrée au retour), en série sur ordinateur ; visite ou appel pour l'agent de terrain.
	 */
	import { can } from '@ziga/shared/permissions';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import ArrearsList from '#lib/components/collections/ArrearsList.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';

	const t = fr.arrears;
	const role = $derived(organizations.active?.role);
</script>

<PageHeader title={role === 'field_agent' ? t.titleAgent : t.title} subtitle={t.subtitle} />

<main class="page pt-3 pb-10">
	{#if !can(role, 'reminder.read')}
		<FormAlert message={fr.app.notFound} />
	{:else}
		<ArrearsList />
	{/if}
</main>
