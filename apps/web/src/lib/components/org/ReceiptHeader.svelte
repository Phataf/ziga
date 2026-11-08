<script lang="ts">
	/**
	 * Aperçu de l'en-tête des reçus (lot 03) : logo, nom et coordonnées de l'organisation, tels qu'ils seront
	 * repris et figés sur chaque reçu émis (D29, lot 09).
	 */
	import { formatPhone } from '@ziga/shared/phone';
	import type { OrganizationView } from '@ziga/shared/organizations';
	import { fr } from '#lib/i18n/fr.ts';

	let { organization }: { organization: OrganizationView } = $props();
	const name = $derived(organization.tradeName ?? organization.legalName);
	const lines = $derived(
		[
			[organization.address, organization.commune].filter(Boolean).join(', '),
			organization.poBox,
			formatPhone(organization.phone),
			[organization.rccm && `RCCM ${organization.rccm}`, organization.ifu && `IFU ${organization.ifu}`].filter(Boolean).join(' · ')
		].filter(Boolean)
	);
</script>

<figure class="space-y-2" data-testid="apercu-entete">
	<figcaption class="text-base font-semibold">{fr.settings.preview}</figcaption>
	<div class="overflow-hidden rounded-xl border bg-white p-4 text-[#1a1a1a] shadow-sm">
		<div class="flex items-start gap-4 border-b border-[#d9d9d9] pb-3">
			{#if organization.logo?.webUrl}
				<img src={organization.logo.webUrl} alt="" class="h-16 w-auto max-w-32 shrink-0 object-contain" />
			{/if}
			<div class="min-w-0 flex-1">
				<p class="text-lg font-bold break-words">{name}</p>
				{#if organization.tradeName && organization.tradeName !== organization.legalName}
					<p class="text-sm break-words">{organization.legalName}</p>
				{/if}
				{#each lines as line (line)}<p class="text-sm break-words">{line}</p>{/each}
			</div>
		</div>
		<p class="pt-3 text-center text-sm font-semibold tracking-widest">{fr.settings.previewReceipt}</p>
	</div>
</figure>
