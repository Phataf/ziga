<script lang="ts">
	import { ChevronRight } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { demo } from '$lib/demo.svelte';
	import { formatDate, formatFCFA, formatMonth } from '$lib/format';
	import { methodLabel, paymentStatusLabel, paymentStatusVariant } from '$lib/labels';
	import OrgTag from '$lib/components/OrgTag.svelte';

	/** Tous les reçus de la personne, toutes agences confondues ; chacun indique son agence. */
	const payments = $derived(
		demo.tenantLeases.flatMap((l) => l.payments.map((p) => ({ ...p, organization: l.organization }))).sort((a, b) => b.date.localeCompare(a.date))
	);
</script>

<PageHeader title="Mes reçus" subtitle="{payments.length} paiement{payments.length > 1 ? 's' : ''}, toutes agences confondues" />

<main class="page pt-3">
	<ul class="divide-y rounded-xl border bg-card md:grid md:grid-cols-2 md:gap-px md:divide-y-0 md:overflow-hidden md:bg-border xl:grid-cols-3" data-testid="recus-locataire">
		{#each payments as p (p.id)}
			<li class="bg-card">
				<a href="/locataire/recus/{p.id}" class="flex min-h-16 items-center gap-3 p-3 hover:bg-accent md:p-4">
					<div class="min-w-0 flex-1">
						<p class="font-semibold tabular-nums">{formatFCFA(p.amount)}</p>
						<p class="truncate text-base text-muted-foreground">
							{formatDate(p.date)} · {methodLabel[p.method]} · {p.allocations.map((a) => formatMonth(a.period)).join(', ') || 'avance'}
						</p>
						<span class="flex flex-wrap gap-1"><Badge variant={paymentStatusVariant[p.status]}>{paymentStatusLabel[p.status]}</Badge><OrgTag organization={p.organization} /></span>
					</div>
					<ChevronRight class="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
				</a>
			</li>
		{:else}
			<li class="p-4 text-muted-foreground">Aucun paiement enregistré.</li>
		{/each}
	</ul>
</main>
