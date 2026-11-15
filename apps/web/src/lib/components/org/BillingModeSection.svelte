<script lang="ts">
	/**
	 * Découpage des loyers (lot 08) : réglage de l'organisation, recopié dans chaque nouveau bail (modifiable bail par bail
	 * dans l'assistant). Changer ce réglage ne touche jamais un bail existant. En ligne seulement (directeur).
	 */
	import type { OrganizationView } from '@ziga/shared/organizations';
	import { RENT_BILLING_MODES, type RentBillingMode } from '@ziga/shared/rent-schedule';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import { messageOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';

	let { view = $bindable(), editable }: { view: OrganizationView; editable: boolean } = $props();
	const t = fr.orgSettings;
	const select = 'min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 text-base';
	let message = $state<string | null>(null);
	let info = $state<string | null>(null);
	let busy = $state(false);

	async function choose(mode: RentBillingMode) {
		message = null;
		info = null;
		busy = true;
		try {
			view = await organizations.call<OrganizationView>('PUT', '/organization/rent-billing-mode', { mode });
			info = t.billingModeSaved;
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}
</script>

<section class="space-y-3 rounded-2xl border bg-card p-4 md:p-6" aria-labelledby="titre-decoupage" data-testid="decoupage-loyers">
	<h2 id="titre-decoupage" class="text-lg font-semibold">{t.billingMode}</h2>
	<p class="text-base text-muted-foreground">{t.billingModeHint}</p>
	<FormAlert {message} />
	<label for="decoupage-organisation" class="sr-only">{t.billingMode}</label>
	<select
		id="decoupage-organisation"
		class={select}
		value={view.rentBillingMode}
		disabled={!editable || busy || !sync.online}
		onchange={(e) => choose((e.currentTarget as HTMLSelectElement).value as RentBillingMode)}
	>
		{#each RENT_BILLING_MODES as m (m)}<option value={m}>{fr.leases.billingModes[m]}</option>{/each}
	</select>
	{#if !sync.online}<FormAlert message={t.billingModeOnline} tone="info" />{/if}
	<FormAlert message={info} tone="info" />
</section>
