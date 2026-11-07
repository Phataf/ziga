<script lang="ts">
	import { Check, MessageCircle, Phone, Send, Wallet } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { ActionMenu } from '$lib/components/ui/menu';
	import { Sheet } from '$lib/components/ui/sheet';
	import { demo } from '$lib/demo.svelte';
	import { device } from '$lib/device.svelte';
	import { formatDate, formatDays, formatFCFA, formatMonth, formatMonthTitle, formatPhone } from '$lib/format';
	import { arrears, type LeaseView } from '$lib/views';
	import { reminderMessage, waLink } from '$lib/whatsapp';

	const list = $derived(arrears(demo.data));
	const total = $derived(list.reduce((s, v) => s + v.overdueAmount, 0));

	let selected = $state<string[]>([]);
	let batchOpen = $state(false);
	const batch = $derived(list.filter((v) => selected.includes(v.lease.id)));
	const sentInBatch = $derived(batch.filter((v) => demo.remindedOn(v.lease.id) === demo.today).length);

	function reminderLink(v: LeaseView) {
		return waLink(
			v.tenant.phone,
			reminderMessage({
				civility: v.tenant.civility,
				name: v.tenant.name,
				amount: v.overdueAmount,
				periods: v.overdueDues.map((d) => d.period),
				oldestDueDate: v.overdueDues[0].dueDate,
				unitLabel: `${v.property.name} — ${v.unit.label}`,
				agency: demo.data.agency
			})
		);
	}
</script>

<PageHeader
	title={demo.profileId === 'field_agent' || demo.profileId === 'landlord' ? 'Retards' : 'Impayés'}
	subtitle="{list.length} locataire{list.length > 1 ? 's' : ''} · {formatFCFA(total)}"
	back="/encaissements"
	backLabel="Encaissements"
/>

<main class="page space-y-3 pt-3">
	<p class="text-base text-muted-foreground">Du plus ancien retard au plus récent.</p>

	<!-- Téléphone : une carte par locataire, les deux actions en boutons pleine largeur. -->
	{#if device.isPhone}
	<div class="space-y-3">
		{#each list as v (v.lease.id)}
			{@const reminded = demo.remindedOn(v.lease.id)}
			<Card.Root data-testid="impaye">
				<Card.Content class="space-y-3">
					<div class="space-y-1">
						<p class="text-lg font-semibold">{v.tenant.civility} {v.tenant.name}</p>
						<p class="text-base text-muted-foreground">{v.property.name} — {v.unit.label}</p>
						<p class="text-base text-muted-foreground">{formatPhone(v.tenant.phone)}</p>
						<Badge variant="danger">{formatDays(v.maxLateDays)} de retard</Badge>
					</div>
					<div class="space-y-2 rounded-lg bg-muted p-3">
						<p class="flex items-baseline justify-between gap-2">
							<span class="font-semibold">Total dû</span>
							<span class="text-xl font-bold text-destructive">{formatFCFA(v.overdueAmount)}</span>
						</p>
						<ul class="space-y-1 border-t pt-2">
							{#each v.overdueDues as d (d.id)}
								<li class="flex justify-between gap-2">
									<span>
										<span class="block">{formatMonthTitle(d.period)}</span>
										<span class="block text-base text-muted-foreground">échue le {formatDate(d.dueDate)}</span>
									</span>
									<span class="text-right">
										<span class="block font-medium">{formatFCFA(d.balance)}</span>
										{#if d.paid > 0}<span class="block text-base text-muted-foreground">sur {formatFCFA(d.amount)}</span>{/if}
									</span>
								</li>
							{/each}
						</ul>
					</div>
					{#if reminded}
						<p class="flex items-center gap-1 text-base text-primary">
							<Check class="size-5" aria-hidden="true" /> Relancé le {formatDate(reminded)}
						</p>
					{/if}
					<div class="grid grid-cols-2 gap-2">
						<Button variant="whatsapp" target="_blank" rel="noopener" href={reminderLink(v)} onclick={() => demo.markReminded(v.lease.id)}>
							<MessageCircle aria-hidden="true" /> Relancer
						</Button>
						<Button variant="outline" href="/encaisser/{v.lease.id}">
							<Wallet aria-hidden="true" /> Encaisser
						</Button>
					</div>
				</Card.Content>
			</Card.Root>
		{:else}
			<p class="rounded-xl border bg-card p-4">Aucun impayé. Bravo !</p>
		{/each}
	</div>

	{:else}
	<!-- Tablette et ordinateur : tableau, sélection multiple, relances en série. -->
	<section class="overflow-hidden rounded-xl border bg-card" aria-label="Tableau des impayés">
		<div class="flex min-h-14 items-center justify-between gap-3 border-b px-4">
			<p class="font-semibold">{selected.length ? `${selected.length} sélectionné${selected.length > 1 ? 's' : ''}` : 'Sélectionnez des locataires pour les relancer en série'}</p>
			<Button disabled={!selected.length} onclick={() => (batchOpen = true)} data-testid="relancer-selection">
				<Send aria-hidden="true" /> Relancer la sélection
			</Button>
		</div>
		<div class="overflow-x-auto">
			<table class="data" data-testid="tableau-impayes">
				<thead>
					<tr>
						<th class="w-1">
							<input
								type="checkbox"
								class="size-5 accent-[var(--color-primary)]"
								aria-label="Tout sélectionner"
								checked={list.length > 0 && selected.length === list.length}
								onchange={(e) => (selected = e.currentTarget.checked ? list.map((v) => v.lease.id) : [])}
							/>
						</th>
						<th>Locataire</th>
						<th class="hidden lg:table-cell">Logement</th>
						<th>Retard</th>
						<th>Mois dus</th>
						<th class="text-right">Total dû</th>
						<th class="hidden xl:table-cell">Dernière relance</th>
						<th><span class="sr-only">Actions</span></th>
					</tr>
				</thead>
				<tbody>
					{#each list as v (v.lease.id)}
						{@const reminded = demo.remindedOn(v.lease.id)}
						<tr>
							<td><input type="checkbox" class="size-5 accent-[var(--color-primary)]" value={v.lease.id} bind:group={selected} aria-label="Sélectionner {v.tenant.name}" /></td>
							<td>
								<p class="font-semibold">{v.tenant.civility} {v.tenant.name}</p>
								<p class="text-muted-foreground tabular-nums">{formatPhone(v.tenant.phone)}</p>
							</td>
							<td class="hidden text-muted-foreground lg:table-cell">{v.property.name} — {v.unit.label}</td>
							<td><Badge variant="danger">{formatDays(v.maxLateDays)}</Badge></td>
							<td class="text-muted-foreground">{v.overdueDues.map((d) => formatMonth(d.period)).join(', ')}</td>
							<td class="text-right font-bold whitespace-nowrap text-destructive tabular-nums">{formatFCFA(v.overdueAmount)}</td>
							<td class="hidden xl:table-cell">
								{#if reminded}<span class="flex items-center gap-1 text-primary"><Check class="size-4" aria-hidden="true" /> {formatDate(reminded)}</span>
								{:else}<span class="text-muted-foreground">Jamais</span>{/if}
							</td>
							<td class="w-1 whitespace-nowrap text-right">
								<div class="flex items-center justify-end gap-1">
									<Button variant="whatsapp" target="_blank" rel="noopener" href={reminderLink(v)} onclick={() => demo.markReminded(v.lease.id)}>
										<MessageCircle aria-hidden="true" /> Relancer
									</Button>
									<ActionMenu
										label="Actions pour {v.tenant.name}"
										actions={[
											{ label: 'Encaisser', icon: Wallet, href: `/encaisser/${v.lease.id}` },
											{ label: 'Appeler', icon: Phone, href: `tel:${v.tenant.phone}` }
										]}
									/>
								</div>
							</td>
						</tr>
					{:else}
						<tr><td colspan="8" class="py-8 text-center">Aucun impayé. Bravo !</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
	{/if}
</main>

<Sheet bind:open={batchOpen} labelledby="titre-relances" side="right">
	<div class="space-y-4">
		<div class="pr-10">
			<h2 id="titre-relances" class="text-xl font-bold">Relances en série</h2>
			<p class="text-muted-foreground">WhatsApp s’ouvre pour chaque locataire, message déjà rédigé. {sentInBatch} sur {batch.length} envoyée{sentInBatch > 1 ? 's' : ''}.</p>
		</div>
		<ol class="space-y-2">
			{#each batch as v, i (v.lease.id)}
				{@const done = demo.remindedOn(v.lease.id) === demo.today}
				<li class="flex items-center gap-3 rounded-xl border p-3">
					<span class="flex size-8 shrink-0 items-center justify-center rounded-full {done ? 'bg-primary text-primary-foreground' : 'bg-muted'} font-semibold">
						{#if done}<Check class="size-4" aria-hidden="true" />{:else}{i + 1}{/if}
					</span>
					<div class="min-w-0 flex-1">
						<p class="truncate font-semibold">{v.tenant.civility} {v.tenant.name}</p>
						<p class="text-muted-foreground">{formatFCFA(v.overdueAmount)} · {formatDays(v.maxLateDays)}</p>
					</div>
					<Button variant={done ? 'outline' : 'whatsapp'} target="_blank" rel="noopener" href={reminderLink(v)} onclick={() => demo.markReminded(v.lease.id)}>
						{done ? 'Renvoyer' : 'Envoyer'}
					</Button>
				</li>
			{/each}
		</ol>
		<Button variant="outline" class="w-full" onclick={() => (batchOpen = false)}>Terminer</Button>
	</div>
</Sheet>
