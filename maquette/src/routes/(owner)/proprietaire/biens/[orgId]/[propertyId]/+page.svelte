<script lang="ts">
	/**
	 * Fiche d'un bien vue par son propriétaire : statut de chaque unité, loyers, bail, caution, dépenses, rendement.
	 * Lecture seule ; sans le nom ni les coordonnées des locataires (docs/UX.md §2).
	 */
	import { page } from '$app/state';
	import { CalendarClock, KeyRound, Lock, Receipt, ShieldCheck, TrendingUp, Wrench } from '@lucide/svelte';
	import OrgTag from '$lib/components/OrgTag.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import UnitStatusBadge from '$lib/components/status/UnitStatusBadge.svelte';
	import { demo } from '$lib/demo.svelte';
	import { declaredValues } from '$lib/fixtures-orgs';
	import { formatDate, formatFCFA, formatMonthTitle } from '$lib/format';
	import { lastPeriods } from '$lib/periods';

	const periods = $derived(lastPeriods(demo.today, 3));
	const groups = $derived(demo.portfolio(periods));
	const group = $derived(groups.find((g) => g.organization.id === page.params.orgId));
	const property = $derived(group?.properties.find((p) => p.id === page.params.propertyId));
	const value = $derived(declaredValues[`${page.params.orgId}/${page.params.propertyId}`]);
	/** Rendement brut : loyers annuels des unités louées, rapportés à la valeur déclarée. */
	const grossYield = $derived(value && property ? ((property.currentRent * 12) / value) * 100 : undefined);
	const maxCollected = $derived(property ? Math.max(1, ...property.collectedByMonth.map((m) => m.amount)) : 1);
</script>

{#if !group || !property}
	<PageHeader title="Bien" back="/proprietaire" backLabel="Mon patrimoine" />
	<p class="p-4">Bien introuvable.</p>
{:else}
	<PageHeader title={property.name} subtitle="{property.district}, {property.city} · {property.kind}" back="/proprietaire" backLabel="Mon patrimoine" />

	<main class="page space-y-4 pt-3" data-testid="fiche-bien-proprietaire">
		<div class="flex flex-wrap items-center gap-2">
			<OrgTag organization={group.organization} />
			<span class="text-base text-muted-foreground">
				{property.selfManaged ? 'Vous gérez ce bien vous-même' : `Mandat de gestion jusqu’au ${formatDate(property.mandateEnd)} · commission ${property.commissionRate} %`}
			</span>
		</div>

		<section class="grid grid-cols-1 gap-3 md:grid-cols-3" aria-label="Chiffres du bien">
			<div class="rounded-xl border bg-card p-4">
				<p class="text-base text-muted-foreground">Loyers des unités louées</p>
				<p class="text-3xl font-bold">{formatFCFA(property.currentRent)}</p>
				<p class="text-base text-muted-foreground">par mois, sur {formatFCFA(property.potentialRent)} possibles</p>
			</div>
			<div class="rounded-xl border bg-card p-4">
				<p class="flex items-center gap-2 text-base text-muted-foreground"><TrendingUp class="size-4" aria-hidden="true" /> Rendement brut</p>
				<p class="text-3xl font-bold" data-testid="rendement">{grossYield !== undefined ? `${grossYield.toFixed(1).replace('.', ',')} %` : '—'}</p>
				<p class="text-base text-muted-foreground">{value ? `par an, pour une valeur déclarée de ${formatFCFA(value)}` : 'Déclarez la valeur du bien pour le calculer'}</p>
			</div>
			<div class="rounded-xl border bg-card p-4">
				<p class="flex items-center gap-2 text-base text-muted-foreground"><Receipt class="size-4" aria-hidden="true" /> Dépenses récentes</p>
				<p class="text-3xl font-bold">{formatFCFA(property.expenses.reduce((s, e) => s + e.amount, 0))}</p>
				<p class="text-base text-muted-foreground">{property.expenses.length} dépense{property.expenses.length > 1 ? 's' : ''} sur trois mois</p>
			</div>
		</section>

		<div class="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_24rem] xl:items-start">
			<section class="space-y-3" aria-labelledby="titre-unites-proprio">
				<h2 id="titre-unites-proprio" class="text-lg font-semibold">Unités ({property.units.length})</h2>
				<ul class="grid grid-cols-1 gap-3 md:grid-cols-2">
					{#each property.units as u (u.id)}
						<li class="space-y-3 rounded-xl border bg-card p-4" data-testid="unite-proprietaire">
							<div class="flex flex-wrap items-start justify-between gap-2">
								<div>
									<p class="font-semibold">{u.label}</p>
									<p class="text-base text-muted-foreground">{u.kind} · {u.rooms} pièce{u.rooms > 1 ? 's' : ''} · {formatFCFA(u.rent)}/mois</p>
								</div>
								<UnitStatusBadge summary={u.summary} />
							</div>
							{#if u.lease}
								<dl class="grid grid-cols-2 gap-x-3 gap-y-1 text-base">
									<dt class="flex items-center gap-1 text-muted-foreground"><KeyRound class="size-4" aria-hidden="true" /> Bail depuis</dt>
									<dd class="text-right">{formatDate(u.lease.since)}</dd>
									<dt class="flex items-center gap-1 text-muted-foreground"><ShieldCheck class="size-4" aria-hidden="true" /> Caution</dt>
									<dd class="text-right">{formatFCFA(u.lease.deposit)}, détenue par {u.lease.depositHolder === 'owner' ? 'vous' : group.organization.name}</dd>
									<dt class="text-muted-foreground">Loyer</dt>
									<dd class="text-right">{u.lease.balanceDue > 0 ? `${formatFCFA(u.lease.balanceDue)} en attente` : 'à jour'}</dd>
								</dl>
								{#if u.lease.notice}
									<p class="flex items-center gap-2 rounded-lg bg-warning-soft p-2 text-base text-warning-foreground">
										<CalendarClock class="size-4 shrink-0" aria-hidden="true" /> Préavis : libre le {formatDate(u.lease.notice.effectiveDate)}
									</p>
								{/if}
							{:else if u.technicalReason && u.summary.label !== 'Disponible'}
								<p class="flex items-start gap-2 text-base"><Wrench class="mt-0.5 size-4 shrink-0" aria-hidden="true" />{u.technicalReason}</p>
							{:else if u.from}
								<p class="text-base">Nouveau locataire attendu le {formatDate(u.from)}.</p>
							{/if}
						</li>
					{/each}
				</ul>
			</section>

			<div class="space-y-4">
				<section class="space-y-3 rounded-xl border bg-card p-4" aria-labelledby="titre-loyers-bien">
					<h2 id="titre-loyers-bien" class="text-lg font-semibold">Loyers encaissés</h2>
					<ul class="space-y-2">
						{#each property.collectedByMonth as m (m.period)}
							<li class="space-y-1">
								<div class="flex justify-between gap-2 text-base"><span>{formatMonthTitle(m.period)}</span><span class="font-semibold tabular-nums">{formatFCFA(m.amount)}</span></div>
								<div class="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true"><div class="h-full rounded-full bg-primary" style:width="{(m.amount / maxCollected) * 100}%"></div></div>
							</li>
						{/each}
					</ul>
				</section>
				<section class="space-y-2 rounded-xl border bg-card p-4" aria-labelledby="titre-depenses-bien">
					<h2 id="titre-depenses-bien" class="text-lg font-semibold">Dépenses</h2>
					<ul class="divide-y">
						{#each property.expenses as e (e.label + e.date)}
							<li class="flex justify-between gap-3 py-2 text-base"><span>{formatDate(e.date)} · {e.label}</span><span class="shrink-0 tabular-nums">{formatFCFA(e.amount)}</span></li>
						{:else}
							<li class="py-2 text-base text-muted-foreground">Aucune dépense.</li>
						{/each}
					</ul>
				</section>
			</div>
		</div>

		<p class="flex items-start gap-2 text-base text-muted-foreground">
			<Lock class="mt-0.5 size-4 shrink-0" aria-hidden="true" /> Lecture seule. Les coordonnées des locataires restent connues du gestionnaire seulement.
		</p>
	</main>
{/if}
