<script lang="ts">
	/**
	 * Lot 10 ter (réponse du porteur au point c) : au dépôt d'un document que la matrice ouvre au propriétaire ou au
	 * locataire lié, l'organisation est avertie que le scan leur sera montré tel quel (la plateforme ne vérifie pas ce
	 * qu'il porte). Règle pure : `partiesWhoSee` (packages/shared/documents).
	 */
	import { Eye } from '@lucide/svelte';
	import { partiesWhoSee, type DocumentType } from '@ziga/shared/documents';
	import { fr } from '#lib/i18n/fr.ts';

	let { type }: { type: DocumentType } = $props();
	const t = fr.documentVisibility;
	const parties = $derived(partiesWhoSee(type));
</script>

{#if parties.length}
	<p class="flex items-start gap-2 rounded-lg bg-info-soft p-3 text-base text-info-foreground" data-testid="visibilite-document">
		<Eye class="mt-0.5 size-5 shrink-0" aria-hidden="true" />{t.notice(parties.map((p) => t.parties[p]).join(t.and))}
	</p>
{/if}
