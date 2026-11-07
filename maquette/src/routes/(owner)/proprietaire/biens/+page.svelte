<script lang="ts">
	import { MapPin } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import PhotoPlaceholder from '$lib/components/PhotoPlaceholder.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { demo } from '$lib/demo.svelte';
	import { formatDate, formatFCFA } from '$lib/format';
	import { unitStatusLabel, unitStatusVariant } from '$lib/labels';
	import { activeLeaseOfUnit, leaseView, propertyUnits } from '$lib/views';
</script>

<PageHeader title="Mes biens" subtitle="{demo.data.properties.length} biens · {demo.data.units.length} unités" />

<main class="page space-y-4 pt-3">
	{#each demo.data.properties as p (p.id)}
		{@const mandate = demo.data.mandates.find((m) => m.id === p.mandateId)!}
		<article class="overflow-hidden rounded-xl border bg-card md:grid md:grid-cols-[16rem_minmax(0,1fr)]">
			<div class="aspect-[400/220] md:aspect-auto md:h-full"><PhotoPlaceholder index={+p.id.slice(1)} label={p.kind} /></div>
			<div class="space-y-3 p-4">
				<div>
					<h2 class="text-lg font-semibold">{p.name}</h2>
					<p class="flex items-center gap-1 text-muted-foreground"><MapPin class="size-4" aria-hidden="true" /> {p.district}, {p.city}</p>
					<p class="text-base text-muted-foreground">Mandat de gestion jusqu’au {formatDate(mandate.endDate)} · commission {mandate.commissionRate} %</p>
				</div>
				<ul class="divide-y rounded-lg border">
					{#each propertyUnits(demo.data, p.id) as u (u.id)}
						{@const lease = activeLeaseOfUnit(demo.data, u.id)}
						{@const v = lease ? leaseView(demo.data, lease.id) : undefined}
						<li class="flex flex-wrap items-center justify-between gap-2 p-3">
							<div class="min-w-0">
								<p class="font-medium">{u.label} · {u.kind}</p>
								<p class="text-base text-muted-foreground">
									{formatFCFA(u.rent)}/mois{#if v} · {v.balanceDue > 0 ? 'loyer en attente' : 'loyer à jour'}{/if}
								</p>
							</div>
							<Badge variant={unitStatusVariant[u.status]}>{unitStatusLabel[u.status]}</Badge>
						</li>
					{/each}
				</ul>
				<p class="text-base text-muted-foreground">Les coordonnées des locataires restent connues de l’agence seulement.</p>
			</div>
		</article>
	{/each}
</main>
