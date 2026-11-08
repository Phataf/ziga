<script lang="ts">
	/**
	 * Historique du locataire, toutes agences confondues (D13) : chaque bail indique son organisation.
	 * Aucune agence ne voit les baux d'une autre (D17) : cet historique n'existe que dans l'espace de la personne.
	 */
	import { Lock, MapPin } from '@lucide/svelte';
	import OrgTag from '$lib/components/OrgTag.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Timeline, { type TimelineEvent } from '$lib/components/Timeline.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { demo } from '$lib/demo.svelte';
	import { formatDate, formatFCFA } from '$lib/format';

	const leases = $derived(demo.tenantLeases);
	const events = $derived.by((): TimelineEvent[] => {
		const ev: TimelineEvent[] = [];
		for (const l of leases) {
			const org = l.organization.name;
			ev.push({ date: l.startDate, title: `Entrée : ${l.property.name} — ${l.unit.label}`, detail: `Loyer ${formatFCFA(l.rent)}, caution ${formatFCFA(l.deposit)}`, organization: org, attachment: 'Bail signé et état des lieux d’entrée', tone: 'success' });
			if (l.notice) ev.push({ date: l.notice.givenOn, title: 'Préavis donné', detail: `${l.notice.reason}. Fin le ${formatDate(l.notice.effectiveDate)}.`, organization: org, tone: 'warning' });
			if (l.endDate) ev.push({ date: l.endDate, title: 'Sortie : remise des clés et état des lieux', organization: org, attachment: 'État des lieux de sortie signé' });
			if (l.settlement) ev.push({ date: l.settlement.date, title: `Caution : ${formatFCFA(l.settlement.refund)} restitués sur ${formatFCFA(l.settlement.deposit)}`, detail: l.settlement.lines.map((x) => `${x.label} (${formatFCFA(x.amount)})`).join(' ; '), organization: org, attachment: 'Décompte de sortie', tone: 'success' });
		}
		return ev.sort((a, b) => b.date.localeCompare(a.date));
	});
</script>

<PageHeader title="Mon historique" subtitle="{leases.length} baux, toutes agences confondues" back="/locataire/plus" backLabel="Plus" />

<main class="page space-y-4 pt-3 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start lg:gap-6 lg:space-y-0" data-testid="historique-locataire">
	<section class="space-y-3" aria-labelledby="titre-baux">
		<h2 id="titre-baux" class="text-lg font-semibold">Mes baux</h2>
		<ul class="space-y-3">
			{#each leases as l (l.leaseId)}
				<li class="space-y-2 rounded-xl border bg-card p-4" data-testid="bail-historique">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<OrgTag organization={l.organization} />
						<Badge variant={l.current ? 'success' : 'outline'}>{l.current ? 'En cours' : 'Terminé'}</Badge>
					</div>
					<p class="font-semibold">{l.property.name} — {l.unit.label}</p>
					<p class="flex items-center gap-1 text-base text-muted-foreground"><MapPin class="size-4" aria-hidden="true" /> {l.property.district}, {l.property.city}</p>
					<p class="text-base">Du {formatDate(l.startDate)}{l.endDate ? ` au ${formatDate(l.endDate)}` : ' à aujourd’hui'} · {formatFCFA(l.rent)}/mois · {l.payments.length} reçu{l.payments.length > 1 ? 's' : ''}</p>
				</li>
			{/each}
		</ul>
		<p class="flex items-start gap-2 text-base text-muted-foreground">
			<Lock class="mt-0.5 size-4 shrink-0" aria-hidden="true" /> Vous seul voyez cet historique. Votre agence actuelle ne voit pas vos anciens baux, et l’ancienne ne voit pas le nouveau.
		</p>
	</section>
	<section class="space-y-3 rounded-xl border bg-card p-4" aria-labelledby="titre-chrono-locataire">
		<h2 id="titre-chrono-locataire" class="text-lg font-semibold">Chronologie</h2>
		<Timeline {events} label="Chronologie de mes baux" testid="chronologie-locataire" />
	</section>
</main>
