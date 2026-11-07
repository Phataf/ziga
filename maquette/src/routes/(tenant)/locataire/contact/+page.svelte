<script lang="ts">
	import { CircleCheck, Wrench } from '@lucide/svelte';
	import AgencyContact from '$lib/components/AgencyContact.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Button } from '$lib/components/ui/button';
	import { demo } from '$lib/demo.svelte';
	import { cn } from '$lib/utils';
	import { leaseView } from '$lib/views';

	const v = $derived(leaseView(demo.data, demo.tenantLeaseId)!);
	const kinds = ['Plomberie, eau', 'Électricité', 'Serrure, porte', 'Autre'];
	let kind = $state(kinds[0]);
	let details = $state('');
	let sent = $state(false);
</script>

<PageHeader title="Contacter l’agence" subtitle="Une question, un problème dans le logement" />

<main class="page space-y-4 pt-3 md:grid md:grid-cols-[minmax(0,1fr)_22rem] md:items-start md:gap-6 md:space-y-0">
	<form
		class="space-y-4 rounded-xl border bg-card p-4 md:p-6"
		onsubmit={(e) => {
			e.preventDefault();
			sent = true;
		}}
	>
		<h2 class="flex items-center gap-2 text-lg font-semibold"><Wrench class="size-5" aria-hidden="true" /> Signaler un problème</h2>
		{#if sent}
			<p class="flex items-center gap-2 rounded-lg bg-success-soft p-3 font-medium" role="status">
				<CircleCheck class="size-6 text-primary" aria-hidden="true" /> Demande envoyée à {demo.data.agency.name}. Elle vous rappellera.
			</p>
		{:else}
			<fieldset>
				<legend class="mb-2 font-semibold">Type de problème</legend>
				<div class="grid grid-cols-2 gap-2">
					{#each kinds as k (k)}
						<label class={cn('flex min-h-12 cursor-pointer items-center rounded-lg border-2 px-3 font-medium', kind === k ? 'border-primary bg-secondary' : 'border-input')}>
							<input type="radio" class="sr-only" name="type" value={k} bind:group={kind} />{k}
						</label>
					{/each}
				</div>
			</fieldset>
			<label class="block space-y-2">
				<span class="font-semibold">Détails</span>
				<textarea bind:value={details} rows="4" class="w-full rounded-lg border-2 border-input bg-card p-3 outline-none focus-visible:border-ring" placeholder="Ex. : fuite sous l’évier de la cuisine depuis hier"></textarea>
			</label>
			<p class="text-base text-muted-foreground">Logement : {v.property.name} — {v.unit.label}. Une photo pourra être ajoutée dans l’application finale.</p>
			<Button type="submit" size="lg" class="w-full md:w-auto" disabled={details.trim().length < 5}>Envoyer la demande</Button>
		{/if}
	</form>
	<AgencyContact message="Bonjour, c’est {v.tenant.civility} {v.tenant.name} ({v.property.name} — {v.unit.label})." />
</main>
