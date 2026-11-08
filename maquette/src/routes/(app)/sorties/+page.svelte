<script lang="ts">
	/** Préavis en cours et sorties closes de l'organisation (lot 10 bis, maquetté au lot 00 ter). */
	import { CalendarClock, ChevronRight, CircleCheck, LogOut } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { demo } from '$lib/demo.svelte';
	import { device } from '$lib/device.svelte';
	import { formatDate, formatFCFA } from '$lib/format';
	import { isLeaseEnded } from '$lib/unit-status';

	const rows = $derived(
		demo.data.leases
			.filter((l) => l.notice || demo.exitOf(l.id))
			.map((l) => {
				const unit = demo.data.units.find((u) => u.id === l.unitId)!;
				const property = demo.data.properties.find((p) => p.id === unit.propertyId)!;
				const tenant = demo.data.tenants.find((t) => t.id === l.tenantId)!;
				const exit = demo.exitOf(l.id);
				const settlement = demo.data.settlements?.find((x) => x.leaseId === l.id);
				const ended = isLeaseEnded(l, demo.today);
				const state = settlement ? 'Sortie close' : exit ? `Brouillon, étape ${exit.step + 1} sur 4` : 'À préparer';
				return { lease: l, unit, property, tenant, exit, settlement, ended, state };
			})
	);
	const open = $derived(rows.filter((r) => !r.settlement));
	const closed = $derived(rows.filter((r) => r.settlement));
</script>

<PageHeader title="Préavis et sorties" subtitle="{open.length} en cours · {closed.length} close{closed.length > 1 ? 's' : ''}" />

<main class="page space-y-6 pt-3" data-testid="sorties">
	<section class="space-y-2" aria-labelledby="titre-preavis">
		<h2 id="titre-preavis" class="text-lg font-semibold">Préavis en cours</h2>
		{#if device.isDesktop && open.length}
			<div class="overflow-x-auto rounded-xl border bg-card">
				<table class="data">
					<thead><tr><th>Locataire</th><th>Logement</th><th>Préavis</th><th>Libre le</th><th>Caution</th><th>État</th><th><span class="sr-only">Action</span></th></tr></thead>
					<tbody>
						{#each open as r (r.lease.id)}
							<tr data-testid="sortie-{r.lease.id}">
								<td class="font-semibold">{r.tenant.civility} {r.tenant.name}</td>
								<td>{r.property.name} — {r.unit.label}</td>
								<td>{r.lease.notice ? formatDate(r.lease.notice.givenOn) : '—'}</td>
								<td>{r.lease.notice ? formatDate(r.lease.notice.effectiveDate) : '—'}</td>
								<td class="tabular-nums">{formatFCFA(r.lease.deposit)}</td>
								<td><Badge variant={r.exit ? 'info' : 'warning'}>{r.state}</Badge></td>
								<td class="text-right"><Button href="/sorties/{r.lease.id}"><LogOut aria-hidden="true" /> {r.exit ? 'Reprendre' : 'Préparer la sortie'}</Button></td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<ul class="grid grid-cols-1 gap-2 md:grid-cols-2">
				{#each open as r (r.lease.id)}
					<li class="space-y-2 rounded-xl border bg-card p-4" data-testid="sortie-{r.lease.id}">
						<div class="flex items-start justify-between gap-2">
							<div class="min-w-0">
								<p class="font-semibold">{r.tenant.civility} {r.tenant.name}</p>
								<p class="text-base text-muted-foreground">{r.property.name} — {r.unit.label}</p>
							</div>
							<Badge variant={r.exit ? 'info' : 'warning'}>{r.state}</Badge>
						</div>
						{#if r.lease.notice}
							<p class="flex items-center gap-2 text-base"><CalendarClock class="size-4 shrink-0" aria-hidden="true" /> Libre le {formatDate(r.lease.notice.effectiveDate)} · caution {formatFCFA(r.lease.deposit)}</p>
						{/if}
						<Button class="w-full" href="/sorties/{r.lease.id}"><LogOut aria-hidden="true" /> {r.exit ? 'Reprendre la sortie' : 'Préparer la sortie'}</Button>
					</li>
				{:else}
					<li class="rounded-xl border bg-card p-4 text-muted-foreground">Aucun préavis en cours.</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="space-y-2" aria-labelledby="titre-closes">
		<h2 id="titre-closes" class="text-lg font-semibold">Sorties closes</h2>
		<ul class="divide-y rounded-xl border bg-card">
			{#each closed as r (r.lease.id)}
				<li>
					<a href="/sorties/{r.lease.id}" class="flex min-h-16 items-center gap-3 p-3 hover:bg-accent">
						<CircleCheck class="size-6 shrink-0 text-primary" aria-hidden="true" />
						<div class="min-w-0 flex-1">
							<p class="font-semibold">{r.tenant.civility} {r.tenant.name} — {r.unit.label}</p>
							<p class="text-base text-muted-foreground">Clés rendues le {formatDate(r.settlement!.inspectionDate)} · {formatFCFA(r.settlement!.refund)} restitués</p>
						</div>
						<ChevronRight class="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
					</a>
				</li>
			{:else}
				<li class="p-4 text-muted-foreground">Aucune sortie close.</li>
			{/each}
		</ul>
	</section>
</main>
