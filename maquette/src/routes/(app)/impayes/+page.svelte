<script lang="ts">
	import { Check, MessageCircle, Wallet } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { demo } from '$lib/demo.svelte';
	import { formatDate, formatDays, formatFCFA, formatMonthTitle, formatPhone } from '$lib/format';
	import { arrears } from '$lib/views';
	import { reminderMessage, waLink } from '$lib/whatsapp';

	const list = $derived(arrears(demo.data));
	const total = $derived(list.reduce((s, v) => s + v.overdueAmount, 0));
</script>

<PageHeader
	title="Impayés"
	subtitle="{list.length} locataire{list.length > 1 ? 's' : ''} · {formatFCFA(total)}"
	back="/encaissements"
/>

<main class="mx-auto max-w-lg space-y-3 px-4 pt-3">
	<p class="text-base text-muted-foreground">Du plus ancien retard au plus récent.</p>
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
					<Button
						variant="whatsapp"
						target="_blank"
						rel="noopener"
						href={waLink(
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
						)}
						onclick={() => demo.markReminded(v.lease.id)}
					>
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
</main>
