<script lang="ts">
	/**
	 * Création rapide (lot 06) : la fiche propriétaire et son mandat de gestion en un seul écran, écrits sur l'appareil
	 * en une transaction locale, même hors connexion ; la synchronisation les envoie. Aucune invitation n'est envoyée au
	 * propriétaire. Valeurs proposées : gestion locative dès aujourd'hui, 10 % des loyers encaissés.
	 */
	import { Save } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { toIsoDate } from '@ziga/shared/dates';
	import { newId } from '@ziga/shared/ids';
	import { can } from '@ziga/shared/permissions';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import CheckField from '#lib/components/owners/CheckField.svelte';
	import MandateFields from '#lib/components/owners/MandateFields.svelte';
	import OwnerFields from '#lib/components/owners/OwnerFields.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { emptyMandateForm, emptyOwnerForm, mandateFromForm, ownerFromForm, type Errors } from '#lib/owners/forms.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';
	import { createOwnerWithMandate } from '#lib/sync/writes.ts';

	const t = fr.owners;
	const allowed = $derived(can(organizations.active?.role, 'owner.create') && organizations.active?.type !== 'landlord');

	let owner = $state(emptyOwnerForm());
	let mandate = $state(emptyMandateForm(toIsoDate()));
	let withMandate = $state(true);
	let ownerErrors = $state<Errors>({});
	let mandateErrors = $state<Errors>({});
	let message = $state<string | null>(null);
	let busy = $state(false);

	async function save(event: SubmitEvent) {
		event.preventDefault();
		message = null;
		const id = newId();
		const o = ownerFromForm(owner);
		const m = withMandate ? mandateFromForm(mandate, { id: newId(), ownerId: id }) : null;
		ownerErrors = o.ok ? {} : o.errors;
		mandateErrors = m && !m.ok ? m.errors : {};
		if (!o.ok || (m && !m.ok)) return;
		const organizationId = organizations.activeId;
		if (!organizationId) return;
		busy = true;
		try {
			const db = sync.db ?? (await sync.start());
			await createOwnerWithMandate(db, organizationId, { id, ...o.value }, m?.ok ? m.value : null);
			await goto(resolve('/app/proprietaires/[id]', { id }), { state: { saved: true } });
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}
</script>

<PageHeader title={t.newTitle} subtitle={t.newSubtitle} back="app/proprietaires" backLabel={t.back} />

<main class="page pt-3 pb-10">
	{#if !allowed}
		<FormAlert message={organizations.active?.type === 'landlord' ? t.landlord : t.readOnly} tone="info" />
	{:else}
		<form class="mx-auto max-w-2xl space-y-6" onsubmit={save} novalidate data-testid="creation-proprietaire">
			<FormAlert {message} />
			<section class="space-y-4 rounded-2xl border bg-card p-4 md:p-6">
				<OwnerFields bind:form={owner} errors={ownerErrors} />
			</section>
			<section class="space-y-4 rounded-2xl border bg-card p-4 md:p-6">
				<CheckField bind:checked={withMandate} label={fr.mandates.withMandate} />
				{#if withMandate}<MandateFields bind:form={mandate} errors={mandateErrors} />{/if}
			</section>
			<Button type="submit" size="lg" class="w-full md:w-auto" disabled={busy}><Save aria-hidden="true" />{t.save}</Button>
		</form>
	{/if}
</main>
