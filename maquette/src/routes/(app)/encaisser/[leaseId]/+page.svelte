<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Banknote, Check, Landmark, Smartphone } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { demo } from '$lib/demo.svelte';
	import { formatFCFA, formatMonth, formatPhone, parseAmount } from '$lib/format';
	import { methodLabel } from '$lib/labels';
	import { allocateOldestFirst } from '$lib/rules';
	import type { PaymentMethod } from '$lib/types';
	import { cn } from '$lib/utils';
	import { leaseView } from '$lib/views';

	const view = $derived(leaseView(demo.data, page.params.leaseId ?? ''));
	const openDues = $derived(view ? view.dues.filter((d) => d.balance > 0) : []);
	/** Montant proposé : le solde exigible, sinon la prochaine échéance. */
	const suggested = $derived(view ? view.balanceDue || openDues[0]?.balance || view.lease.rent : 0);

	let amountInput = $state('');
	let touched = $state(false);
	let method = $state<PaymentMethod>('cash');
	let reference = $state('');
	let submitting = $state(false);

	$effect(() => {
		if (!touched) amountInput = String(suggested);
	});

	const amount = $derived(parseAmount(amountInput));
	const preview = $derived(amount && amount > 0 && openDues.length ? allocateOldestFirst(amount, openDues) : null);
	const isMobileMoney = $derived(method === 'orange_money' || method === 'moov_money');
	const needsReference = $derived(isMobileMoney);
	const canSubmit = $derived(!!amount && amount > 0 && (!needsReference || reference.trim().length >= 4) && !submitting);

	const methods: { id: PaymentMethod; icon: typeof Banknote }[] = [
		{ id: 'cash', icon: Banknote },
		{ id: 'orange_money', icon: Smartphone },
		{ id: 'moov_money', icon: Smartphone },
		{ id: 'transfer', icon: Landmark }
	];

	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!view || !amount || !canSubmit) return;
		submitting = true;
		const payment = demo.collect({ leaseId: view.lease.id, amount, method, reference });
		goto(`/recus/${payment.id}?nouveau=1`, { replaceState: true });
	}
</script>

<PageHeader title="Encaisser" subtitle="Étape 2 : vérifier et valider" back="/encaisser" />

{#if !view}
	<p class="p-4">Locataire introuvable.</p>
{:else}
	<form class="mx-auto max-w-lg space-y-4 px-4 pt-3 pb-32" onsubmit={submit}>
		<Card.Root>
			<Card.Content class="space-y-1">
				<p class="text-lg font-semibold" data-testid="locataire">{view.tenant.civility} {view.tenant.name}</p>
				<p class="text-base text-muted-foreground">{view.property.name} — {view.unit.label}, {view.property.district}</p>
				<p class="text-base text-muted-foreground">{formatPhone(view.tenant.phone)}</p>
				<p class="pt-1 text-base">
					{#if view.balanceDue > 0}
						Solde dû : <strong class={view.overdueAmount > 0 ? 'text-destructive' : ''}>{formatFCFA(view.balanceDue)}</strong>
					{:else}
						<span class="font-semibold text-primary">À jour</span> — paiement d’avance
					{/if}
				</p>
			</Card.Content>
		</Card.Root>

		<div class="space-y-2">
			<label for="montant" class="block text-lg font-semibold">Montant reçu</label>
			<div class="relative">
				<Input
					id="montant"
					name="montant"
					inputmode="numeric"
					pattern="[0-9 ]*"
					autocomplete="off"
					class="min-h-16 pr-20 text-3xl font-bold"
					bind:value={amountInput}
					oninput={() => (touched = true)}
					aria-describedby="montant-aide"
				/>
				<span class="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-lg font-semibold text-muted-foreground">FCFA</span>
			</div>
			<p id="montant-aide" class="text-base text-muted-foreground">
				{#if amount === null}
					<span class="text-destructive">Saisissez un montant en chiffres, sans virgule.</span>
				{:else}
					soit <strong>{formatFCFA(amount)}</strong>
				{/if}
			</p>
			{#if preview}
				<ul class="space-y-1 rounded-lg bg-muted p-3 text-base" data-testid="imputation">
					{#each preview.allocations as a (a.rentDueId)}
						{@const due = openDues.find((d) => d.id === a.rentDueId)}
						<li class="flex justify-between gap-2">
							<span>Loyer de {formatMonth(a.period)}</span>
							<span class="font-medium">
								{formatFCFA(a.amount)}{due && a.amount < due.balance ? ' (partiel)' : ''}
							</span>
						</li>
					{/each}
					{#if preview.advance > 0}
						<li class="flex justify-between gap-2"><span>Avance</span><span class="font-medium">{formatFCFA(preview.advance)}</span></li>
					{/if}
				</ul>
			{/if}
		</div>

		<fieldset class="space-y-2">
			<legend class="mb-2 text-lg font-semibold">Moyen de paiement</legend>
			<div class="grid grid-cols-2 gap-2">
				{#each methods as m (m.id)}
					<label
						class={cn(
							'flex min-h-14 cursor-pointer items-center gap-2 rounded-lg border-2 bg-card px-3 font-medium',
							method === m.id ? 'border-primary bg-secondary text-secondary-foreground' : 'border-input'
						)}
					>
						<input type="radio" name="moyen" value={m.id} bind:group={method} class="sr-only" />
						{#if method === m.id}
							<Check class="size-5 shrink-0 text-primary" aria-hidden="true" />
						{:else}
							<m.icon class="size-5 shrink-0" aria-hidden="true" />
						{/if}
						{methodLabel[m.id]}
					</label>
				{/each}
			</div>
		</fieldset>

		{#if method !== 'cash'}
			<div class="space-y-2">
				<label for="reference" class="block text-lg font-semibold">
					Référence {isMobileMoney ? 'de la transaction' : 'du virement'}
					{#if !needsReference}<span class="font-normal text-muted-foreground">(facultatif)</span>{/if}
				</label>
				<Input id="reference" name="reference" autocomplete="off" placeholder={isMobileMoney ? 'ex. PP261107.1532.A12345' : 'ex. VIR-0012'} bind:value={reference} />
				{#if isMobileMoney}
					<p class="rounded-lg bg-warning-soft p-3 text-base text-warning-foreground">
						Le paiement restera « à rapprocher » jusqu’à la vérification de la référence.
					</p>
				{/if}
			</div>
		{/if}

		<div class="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 border-t bg-background/95 p-3 backdrop-blur">
			<div class="mx-auto max-w-lg">
				<Button type="submit" size="lg" class="w-full text-xl" disabled={!canSubmit}>
					<Check class="size-6" aria-hidden="true" />
					Valider {amount ? formatFCFA(amount) : ''}
				</Button>
			</div>
		</div>
	</form>
{/if}
