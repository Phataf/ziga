<script lang="ts">
	/** Pastille de statut (synthèse sur les cartes et tableaux, ou une dimension sur la fiche) : un mot, jamais une couleur seule. */
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import type { Tone } from '#lib/properties/views.ts';

	let { label, tone, prefix }: { label: string; tone: Tone; prefix?: string } = $props();
</script>

<Badge variant={tone} class="text-sm" data-testid="pastille"
	>{#if prefix}<span class="font-normal">{prefix} :&nbsp;</span>{/if}{label}</Badge
>
