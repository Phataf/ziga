<script lang="ts">
	/** Relevé de gestion d'un propriétaire : même document dans l'espace agence et dans l'espace propriétaire. */
	import { formatDate, formatFCFA, formatMonthTitle } from '$lib/format';
	import type { OwnerStatement } from '$lib/views';

	let { st, period, agencyName }: { st: OwnerStatement; period: string; agencyName: string } = $props();
</script>

<article class="space-y-4 rounded-xl border bg-white p-4 md:p-6" data-testid="releve">
	<header class="border-b pb-3">
		<p class="text-base text-muted-foreground">{agencyName} — relevé de gestion</p>
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
