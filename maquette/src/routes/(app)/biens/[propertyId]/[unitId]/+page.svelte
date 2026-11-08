<script lang="ts">
	/**
	 * Fiche unité : statut en quatre dimensions (D14), bail, caution, chronologie.
	 * L'occupation n'est jamais saisie : elle découle des baux. L'état technique, lui, se saisit ici.
	 */
	import { page } from '$app/state';
	import { CalendarClock, Hammer, Info, KeyRound, LogOut, ShieldCheck, Sparkles, Wallet } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import UnitDimensions from '$lib/components/status/UnitDimensions.svelte';
	import UnitStatusBadge from '$lib/components/status/UnitStatusBadge.svelte';
	import Timeline, { type TimelineEvent } from '$lib/components/Timeline.svelte';
	import { Button } from '$lib/components/ui/button';
	import { demo } from '$lib/demo.svelte';
	import { depositBalance } from '$lib/deposit';
	import { formatDate, formatFCFA, formatPhone } from '$lib/format';
	import { allLeases, summaryOfUnit, technicalLabel } from '$lib/unit-status';

	const property = $derived(demo.data.properties.find((p) => p.id === page.params.propertyId));
	const unit = $derived(demo.data.units.find((u) => u.id === page.params.unitId && u.propertyId === page.params.propertyId));
	const summary = $derived(unit ? summaryOfUnit(demo.data, unit) : undefined);
	const lease = $derived(summary?.lease);
	const tenant = $derived(
		lease ? [...demo.data.tenants, ...(demo.data.upcomingTenants ?? [])].find((t) => t.id === lease.tenantId) : undefined
	);
	const movements = $derived(lease ? (demo.data.depositMovements ?? []).filter((m) => m.leaseId === lease.id) : []);
	const technical = $derived(unit?.technical ?? 'ready');
	const canManage = $derived(demo.profileId !== 'field_agent');

	const events = $derived.by((): TimelineEvent[] => {
		if (!unit) return [];
		const ev: TimelineEvent[] = [];
		const leases = allLeases(demo.data).filter((l) => l.unitId === unit.id);
		const nameOf = (id: string) => {
			const t = [...demo.data.tenants, ...(demo.data.upcomingTenants ?? [])].find((x) => x.id === id);
			return t ? `${t.civility} ${t.name}` : '';
		};
		for (const l of leases) {
			const signed = l.startDate > demo.today;
			ev.push({ date: signed ? (demo.data.depositMovements?.find((m) => m.leaseId === l.id)?.date ?? demo.today) : l.startDate, title: signed ? `Bail signé, entrée le ${formatDate(l.startDate)}` : 'Entrée du locataire, état des lieux d’entrée', detail: nameOf(l.tenantId), author: demo.full.agency.name, tone: 'success' });
			if (l.notice) ev.push({ date: l.notice.givenOn, title: `Préavis donné par ${l.notice.by === 'tenant' ? 'le locataire' : 'le bailleur'}`, detail: `${l.notice.reason}. Fin du préavis le ${formatDate(l.notice.effectiveDate)}.`, author: demo.full.agency.name, attachment: 'Lettre de préavis', tone: 'warning' });
			const st = demo.data.settlements?.find((x) => x.leaseId === l.id);
			if (st) ev.push({ date: st.inspectionDate, title: 'Sortie : état des lieux et remise des clés', detail: `Décompte : ${formatFCFA(st.refund)} restitués sur ${formatFCFA(st.deposit)}.`, author: demo.full.agency.name, attachment: 'État des lieux de sortie signé', tone: 'warning' });
		}
		const t = demo.log.technical[unit.id];
		if (t) ev.push({ date: t.on, title: `État technique : ${technicalLabel[t.state].toLowerCase()}`, author: demo.full.agency.name });
		return ev.sort((a, b) => b.date.localeCompare(a.date));
	});
</script>

{#if !property || !unit || !summary}
	<PageHeader title="Unité" back="/biens" backLabel="Biens" />
	<p class="p-4">Unité introuvable.</p>
{:else}
	<PageHeader title="{property.name} — {unit.label}" subtitle="{unit.kind} · {unit.rooms} pièce{unit.rooms > 1 ? 's' : ''} · {formatFCFA(unit.rent)}/mois" back="/biens/{property.id}" backLabel={property.name} />

	<main class="page space-y-4 pt-3 xl:grid xl:grid-cols-[minmax(0,1fr)_24rem] xl:items-start xl:gap-6 xl:space-y-0" data-testid="fiche-unite">
		<div class="space-y-4">
			<section class="space-y-3 rounded-xl border bg-card p-4" aria-labelledby="titre-statut">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<h2 id="titre-statut" class="text-lg font-semibold">Statut</h2>
					<UnitStatusBadge summary={summary} testid="synthese-unite" />
				</div>
				<UnitDimensions {unit} />
				<p class="flex items-start gap-2 text-base text-muted-foreground">
					<Info class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
					Disponible = fiche active, libre ou en préavis, et prête. L’occupation découle des baux, elle ne se saisit pas ; la fin d’un bail fait passer l’unité « à remettre en état ».
				</p>
			</section>

			{#if canManage && summary.occupancy !== 'occupied' && summary.occupancy !== 'notice' && summary.occupancy !== 'reserved'}
				<section class="space-y-3 rounded-xl border bg-card p-4" aria-labelledby="titre-technique">
					<h2 id="titre-technique" class="text-lg font-semibold">Remise en état</h2>
					{#if unit.technicalReason && technical !== 'ready'}<p class="text-base">{unit.technicalReason}</p>{/if}
					{#if technical === 'to_refurbish'}
						<p class="text-base text-muted-foreground">L’unité ne redevient disponible qu’une fois les travaux faits, ou s’il n’y a rien à réparer.</p>
						<div class="grid grid-cols-1 gap-2 md:grid-cols-2">
							<Button variant="outline" onclick={() => demo.setTechnical(unit.id, 'works')}><Hammer aria-hidden="true" /> Lancer les travaux</Button>
							<Button onclick={() => demo.setTechnical(unit.id, 'ready')}><Sparkles aria-hidden="true" /> Rien à réparer : prête</Button>
						</div>
					{:else if technical === 'works'}
						<Button onclick={() => demo.setTechnical(unit.id, 'ready')}><Sparkles aria-hidden="true" /> Travaux terminés : prête</Button>
					{:else}
						<p class="text-base text-muted-foreground">Prête à être louée.</p>
						<Button variant="outline" href="/biens/{property.id}">Publier depuis la fiche du bien</Button>
					{/if}
				</section>
			{/if}

			{#if lease}
				<section class="space-y-3 rounded-xl border bg-card p-4" aria-labelledby="titre-bail">
					<h2 id="titre-bail" class="flex items-center gap-2 text-lg font-semibold">
						<KeyRound class="size-5" aria-hidden="true" />
						{summary.occupancy === 'reserved' ? 'Bail signé, à venir' : 'Bail en cours'}
					</h2>
					<dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-base">
						{#if tenant}
							<dt class="text-muted-foreground">Locataire</dt>
							<dd class="text-right font-medium">{tenant.civility} {tenant.name}<br /><span class="font-normal text-muted-foreground">{formatPhone(tenant.phone)}</span></dd>
						{/if}
						<dt class="text-muted-foreground">{summary.occupancy === 'reserved' ? 'Entrée le' : 'Depuis le'}</dt>
						<dd class="text-right font-medium">{formatDate(lease.startDate)}</dd>
						<dt class="text-muted-foreground">Durée</dt>
						<dd class="text-right font-medium">{lease.term === 'fixed' ? 'Déterminée' : 'Indéterminée'}</dd>
						<dt class="text-muted-foreground">Loyer et charges</dt>
						<dd class="text-right font-medium">{formatFCFA(lease.rent + lease.charges)}</dd>
					</dl>
					{#if lease.notice}
						<div class="space-y-1 rounded-lg bg-warning-soft p-3 text-warning-foreground" data-testid="preavis">
							<p class="flex items-center gap-2 font-semibold"><CalendarClock class="size-5" aria-hidden="true" /> Préavis du {formatDate(lease.notice.givenOn)}, libre le {formatDate(lease.notice.effectiveDate)}</p>
							<p class="text-base">Donné par {lease.notice.by === 'tenant' ? 'le locataire' : 'le bailleur'} : {lease.notice.reason}.</p>
						</div>
					{/if}
					{#if canManage && summary.occupancy !== 'reserved'}
						<div class="grid grid-cols-1 gap-2 md:grid-cols-2">
							<Button href="/sorties/{lease.id}"><LogOut aria-hidden="true" /> {lease.notice ? 'Préparer la sortie' : 'Enregistrer un préavis'}</Button>
							<Button variant="outline" href="/encaisser/{lease.id}"><Wallet aria-hidden="true" /> Encaisser</Button>
						</div>
					{/if}
				</section>

				<section class="space-y-2 rounded-xl border bg-card p-4" aria-labelledby="titre-caution">
					<h2 id="titre-caution" class="flex items-center gap-2 text-lg font-semibold"><ShieldCheck class="size-5" aria-hidden="true" /> Compte de caution</h2>
					<dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-base">
						<dt class="text-muted-foreground">Caution convenue</dt>
						<dd class="text-right font-medium">{formatFCFA(lease.deposit)}</dd>
						<dt class="text-muted-foreground">Détenue par</dt>
						<dd class="text-right font-medium">{lease.depositHolder === 'owner' ? 'Le propriétaire' : demo.full.agency.kind === 'landlord' ? 'Le bailleur' : 'L’agence'}</dd>
						<dt class="text-muted-foreground">Solde du compte</dt>
						<dd class="text-right font-semibold tabular-nums">{formatFCFA(depositBalance(movements))}</dd>
					</dl>
				</section>
			{/if}
		</div>

		<aside class="space-y-2 rounded-xl border bg-card p-4" aria-labelledby="titre-chronologie">
			<h2 id="titre-chronologie" class="text-lg font-semibold">Chronologie</h2>
			<Timeline {events} label="Chronologie de l’unité" testid="chronologie-unite" />
		</aside>
	</main>
{/if}
