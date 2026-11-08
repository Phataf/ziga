<script lang="ts">
	/** Pastille de synthèse d'une unité (cartes, tableaux) : « Disponible », « Louée », « En préavis, libre le… ». */
	import { CircleCheck, Clock, Hammer, KeyRound, Wrench } from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import type { UnitSummary } from '$lib/unit-status';

	let { summary, testid }: { summary: Pick<UnitSummary, 'label' | 'variant'>; testid?: string } = $props();
	const Icon = $derived(
		summary.label === 'Disponible'
			? CircleCheck
			: summary.label === 'Louée'
				? KeyRound
				: summary.label.startsWith('En préavis') || summary.label.startsWith('Réservée')
					? Clock
					: summary.label === 'En travaux'
						? Hammer
						: Wrench
	);
</script>

<Badge variant={summary.variant} data-testid={testid}><Icon aria-hidden="true" />{summary.label}</Badge>
