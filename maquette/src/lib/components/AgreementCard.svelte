<script lang="ts">
	/**
	 * Circuit d'accord (docs/UX.md §10) : proposition, acceptation ou refus motivé, horodatage,
	 * visible des deux parties. Utilisé pour l'imputation de la caution et les réparations du locataire.
	 */
	import { Check, CircleCheck, CircleX, Clock, X } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import type { Agreement } from '$lib/deposit';
	import { formatDate } from '$lib/format';

	let {
		agreement,
		proposer,
		decider,
		today,
		ondecide,
		testid
	}: {
		agreement: Agreement;
		proposer: string;
		decider: string;
		today: string;
		ondecide: (a: Agreement) => void;
		testid?: string;
	} = $props();

	let refusing = $state(false);
	let reason = $state('');
</script>

<section class="space-y-3 rounded-xl border bg-card p-4" aria-label="Accord" data-testid={testid}>
	<div class="flex flex-wrap items-center justify-between gap-2">
		<p class="font-semibold">Accord écrit</p>
		{#if agreement.status === 'accepted'}
			<span class="flex items-center gap-1 font-medium text-primary"><CircleCheck class="size-5" aria-hidden="true" /> Accepté le {formatDate(agreement.decidedOn!)}</span>
		{:else if agreement.status === 'refused'}
			<span class="flex items-center gap-1 font-medium text-destructive"><CircleX class="size-5" aria-hidden="true" /> Refusé le {formatDate(agreement.decidedOn!)}</span>
		{:else}
			<span class="flex items-center gap-1 font-medium text-warning-foreground"><Clock class="size-5" aria-hidden="true" /> En attente de réponse</span>
		{/if}
	</div>
	<blockquote class="rounded-lg bg-muted p-3 text-base">« {agreement.text} »</blockquote>
	<p class="text-base text-muted-foreground">Proposé par {proposer} le {formatDate(agreement.proposedOn)}.</p>
	{#if agreement.status === 'refused' && agreement.reason}
		<p class="text-base">Motif du refus : {agreement.reason}</p>
	{/if}
	{#if agreement.status === 'proposed'}
		{#if refusing}
			<label class="block space-y-1">
				<span class="font-semibold">Motif du refus (obligatoire)</span>
				<textarea bind:value={reason} rows="2" class="w-full rounded-lg border-2 border-input bg-card p-3 outline-none focus-visible:border-ring"></textarea>
			</label>
			<div class="grid grid-cols-2 gap-2">
				<Button variant="outline" onclick={() => (refusing = false)}>Annuler</Button>
				<Button
					variant="destructive"
					disabled={reason.trim().length < 5}
					onclick={() => ondecide({ ...agreement, status: 'refused', decidedOn: today, decidedBy: decider, reason: reason.trim() })}
				>
					<X aria-hidden="true" /> Refuser
				</Button>
			</div>
		{:else}
			<div class="grid grid-cols-2 gap-2">
				<Button variant="outline" onclick={() => (refusing = true)}><X aria-hidden="true" /> Refuser</Button>
				<Button onclick={() => ondecide({ ...agreement, status: 'accepted', decidedOn: today, decidedBy: decider })}><Check aria-hidden="true" /> Accepter</Button>
			</div>
			<p class="text-base text-muted-foreground">La réponse de {decider} sera datée et visible des deux parties.</p>
		{/if}
	{/if}
</section>
