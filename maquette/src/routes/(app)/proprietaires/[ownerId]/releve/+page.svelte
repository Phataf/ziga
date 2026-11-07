<script lang="ts">
	import { page } from '$app/state';
	import { Check, Send } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Button } from '$lib/components/ui/button';
	import { demo } from '$lib/demo.svelte';
	import { formatDate, formatFCFA, formatMonthTitle } from '$lib/format';
	import { ownerStatement } from '$lib/views';
	import { statementMessage, waLink } from '$lib/whatsapp';
	import { cn } from '$lib/utils';

	function shift(period: string, delta: number) {
		const d = new Date(+period.slice(0, 4), +period.slice(5, 7) - 1 + delta, 1);
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
	}

	const current = $derived(demo.today.slice(0, 7));
	const previous = $derived(shift(current, -1));
	let chosen = $state<string | null>(null);
	const period = $derived(chosen ?? page.url.searchParams.get('mois') ?? previous);

	const st = $derived(ownerStatement(demo.data, page.params.ownerId ?? '', period));
	const sentOn = $derived(st ? demo.statementSentOn(st.owner.id, period) : undefined);
	const link = $derived(st ? `${page.url.origin}/proprietaires/${st.owner.id}/releve?mois=${period}` : '');
	const whatsapp = $derived(
		st
			? waLink(
					st.owner.phone,
					statementMessage({
						civility: st.owner.civility,
						name: st.owner.name,
						period,
						net: st.totals.net,
						url: link,
						agency: demo.data.agency
					})
				)
			: ''
	);
</script>

<PageHeader title="Relevé propriétaire" subtitle={st ? `${st.owner.civility} ${st.owner.name}` : ''} back="/proprietaires" backLabel="Propriétaires" />

{#if !st}
	<p class="p-4">Propriétaire introuvable.</p>
{:else}
	<main class="mx-auto max-w-lg space-y-4 px-4 pt-3">
		<div class="grid grid-cols-2 gap-2" role="group" aria-label="Choisir le mois">
			{#each [{ p: previous, l: formatMonthTitle(previous) }, { p: current, l: `${formatMonthTitle(current)} (en cours)` }] as m (m.p)}
				<button
					type="button"
					class={cn(
						'min-h-11 rounded-lg border-2 px-2 font-medium',
						period === m.p ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card'
					)}
					aria-pressed={period === m.p}
					onclick={() => (chosen = m.p)}
				>
					{m.l}
				</button>
			{/each}
		</div>

		<article class="space-y-4 rounded-xl border bg-white p-4" data-testid="releve">
			<header class="border-b pb-3">
				<p class="text-base text-muted-foreground">{demo.data.agency.name} — relevé de gestion</p>
				<h2 class="text-xl font-bold">{formatMonthTitle(period)}</h2>
				<p>{st.owner.civility} {st.owner.name}</p>
			</header>

			<section aria-labelledby="titre-loyers">
				<h3 id="titre-loyers" class="mb-1 font-semibold">Loyers encaissés</h3>
				<ul class="space-y-2">
					{#each st.lines as l (l.paymentId)}
						<li class="flex justify-between gap-3">
							<span class="min-w-0">
								<span class="block">{l.label}</span>
								<span class="block text-base text-muted-foreground">le {formatDate(l.date)}</span>
							</span>
							<span class="shrink-0 font-medium">{formatFCFA(l.amount)}</span>
						</li>
					{:else}
						<li class="text-muted-foreground">Aucun loyer encaissé sur la période.</li>
					{/each}
				</ul>
				<p class="mt-2 flex justify-between border-t pt-2 font-semibold">
					<span>Total des loyers</span><span data-testid="total-loyers">{formatFCFA(st.totals.received)}</span>
				</p>
			</section>

			<section class="space-y-2" aria-labelledby="titre-deductions">
				<h3 id="titre-deductions" class="font-semibold">Déductions</h3>
				<p class="flex justify-between gap-3">
					<span>Commission de gestion ({st.commissionRates.join(' et ') || '—'} %)</span>
					<span class="shrink-0" data-testid="commission">− {formatFCFA(st.totals.commission)}</span>
				</p>
				{#each st.expenses as e (e.id)}
					<p class="flex justify-between gap-3">
						<span class="min-w-0">
							<span class="block">{e.label}</span>
							<span class="block text-base text-muted-foreground">{e.propertyName}, le {formatDate(e.date)}</span>
						</span>
						<span class="shrink-0">− {formatFCFA(e.amount)}</span>
					</p>
				{:else}
					<p class="text-muted-foreground">Aucune dépense sur la période.</p>
				{/each}
			</section>

			<p class="flex items-end justify-between rounded-lg bg-success-soft p-3">
				<span class="font-semibold">Net à reverser</span>
				<span class="text-2xl font-bold text-primary" data-testid="net">{formatFCFA(st.totals.net)}</span>
			</p>
		</article>

		{#if sentOn}
			<p class="flex items-center gap-1 text-primary"><Check class="size-5" aria-hidden="true" /> Lien envoyé le {formatDate(sentOn)}</p>
		{/if}
		<Button
			href={whatsapp}
			target="_blank"
			rel="noopener"
			variant="whatsapp"
			size="lg"
			class="w-full"
			onclick={() => demo.markStatementSent(st.owner.id, period)}
			data-testid="envoyer-releve"
		>
			<Send class="size-6" aria-hidden="true" /> Envoyer le lien
		</Button>
		<p class="text-center text-base text-muted-foreground">Le propriétaire n’a pas besoin de compte : il ouvre le lien.</p>
	</main>
{/if}
