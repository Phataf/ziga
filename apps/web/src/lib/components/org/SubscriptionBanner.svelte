<script lang="ts">
	/** Bandeau d'abonnement (lot 04) : échéance proche, délai de grâce, créations bloquées. Rien n'est jamais supprimé. */
	import { onMount } from 'svelte';
	import { TriangleAlert } from '@lucide/svelte';
	import { formatDate } from '@ziga/shared/dates';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { subscription } from '#lib/org/subscription.svelte.ts';

	const t = fr.subscriptionBanner;
	onMount(() => subscription.load());
	const s = $derived(subscription.state);
	// L'échéance proche ne concerne que le directeur ; un blocage, tout le monde (les créations sont refusées).
	const director = $derived(organizations.active?.role === 'director');
	const message = $derived(
		!s
			? null
			: s.stage === 'blocked'
				? t.blocked
				: s.stage === 'grace' && s.blockedFrom
					? t.grace(formatDate(s.blockedFrom))
					: s.stage === 'reminder' && director && s.paidUntil
						? t.reminder(formatDate(s.paidUntil))
						: null
	);
</script>

{#if message}
	<!-- Bandeau permanent, pas une mise à jour : une note, pas une zone annoncée (role="status"). -->
	<p
		role="note"
		class="flex items-start gap-2 px-4 py-2 text-base {s?.stage === 'blocked'
			? 'bg-danger-soft text-destructive'
			: 'bg-warning-soft text-warning-foreground'}"
		data-testid="bandeau-abonnement"
	>
		<TriangleAlert class="mt-0.5 size-5 shrink-0" aria-hidden="true" />{message}
	</p>
{/if}
