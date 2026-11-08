<script lang="ts">
	import { CalendarClock, ChevronRight, CircleCheck, History, Lock, MapPin, Receipt, ShieldCheck, Smartphone } from '@lucide/svelte';
	import OrgTag from '$lib/components/OrgTag.svelte';
	import AgencyContact from '$lib/components/AgencyContact.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { demo } from '$lib/demo.svelte';
	import { formatDate, formatDays, formatFCFA, formatMonthTitle } from '$lib/format';
	import { leaseView } from '$lib/views';

	const v = $derived(leaseView(demo.data, demo.tenantLeaseId)!);
	const past = $derived(demo.tenantLeases.filter((l) => !l.current));
	const history = $derived(v.dues.filter((d) => d.dueDate <= demo.today || d.balance > 0).slice(-6).reverse());
</script>

<PageHeader title="Bonjour {v.tenant.civility} {v.tenant.name}" subtitle="{v.property.name} — {v.unit.label}" />

<main class="page space-y-4 pt-3 md:grid md:grid-cols-[minmax(0,1fr)_22rem] md:items-start md:gap-6 md:space-y-0" data-testid="espace-locataire">
	<div class="space-y-4">
		{#if v.balanceDue > 0}
			<Card.Root class="border-destructive/30 bg-danger-soft">
				<Card.Content class="space-y-2">
					<p class="text-base">Montant à régler</p>
					<p class="text-3xl font-bold text-destructive" data-testid="solde-locataire">{formatFCFA(v.balanceDue)}</p>
					{#if v.overdueAmount > 0}<Badge variant="danger">{formatDays(v.maxLateDays)} de retard</Badge>{/if}
				</Card.Content>
			</Card.Root>
		{:else}
			<Card.Root class="border-primary/30 bg-success-soft">
				<Card.Content class="flex items-center gap-3">
					<CircleCheck class="size-8 text-primary" aria-hidden="true" />
					<div>
						<p class="text-lg font-semibold">Vous êtes à jour</p>
						{#if v.nextDue}<p class="text-base">Prochain loyer : {formatFCFA(v.nextDue.balance)} le {formatDate(v.nextDue.dueDate)}</p>{/if}
					</div>
				</Card.Content>
			</Card.Root>
		{/if}

		<!-- Paiement direct : fonctionnalité « payments.direct », coupée tant que l'agence n'y est pas ouverte (lot 14). -->
		<div class="space-y-2 rounded-xl border bg-card p-4">
			<Button size="lg" class="w-full py-3 whitespace-normal" disabled>
				<Smartphone class="size-6" aria-hidden="true" /> Payer par Orange Money ou Moov Money
			</Button>
			<p class="flex items-center gap-2 text-base text-muted-foreground">
				<Lock class="size-4 shrink-0" aria-hidden="true" /> Bientôt : votre agence n’a pas encore activé le paiement en ligne. Payez-la comme d’habitude.
			</p>
		</div>

		<section class="overflow-hidden rounded-xl border bg-card" aria-labelledby="titre-echeancier">
			<h2 id="titre-echeancier" class="flex items-center gap-2 border-b px-4 py-3 text-lg font-semibold">
				<CalendarClock class="size-5" aria-hidden="true" /> Mes échéances
			</h2>
			<ul class="divide-y">
				{#each history as d (d.id)}
					<li class="flex items-center justify-between gap-3 px-4 py-3">
						<div>
							<p class="font-medium">{formatMonthTitle(d.period)}</p>
							<p class="text-base text-muted-foreground">échéance le {formatDate(d.dueDate)}</p>
						</div>
						<div class="text-right">
							<p class="font-semibold tabular-nums">{formatFCFA(d.amount)}</p>
							{#if d.balance === 0}<Badge variant="success">Payé</Badge>
							{:else if d.paid > 0}<Badge variant="warning">Reste {formatFCFA(d.balance)}</Badge>
							{:else if d.dueDate < demo.today}<Badge variant="danger">En retard</Badge>
							{:else}<Badge variant="outline">À venir</Badge>{/if}
						</div>
					</li>
				{/each}
			</ul>
		</section>
	</div>

	<aside class="space-y-4">
		<section class="space-y-2 rounded-xl border bg-card p-4" aria-labelledby="titre-logement">
			<h2 id="titre-logement" class="text-lg font-semibold">Mon logement</h2>
			<OrgTag organization={demo.data.agency} />
			<p class="flex items-center gap-1 text-muted-foreground"><MapPin class="size-4" aria-hidden="true" /> {v.property.district}, {v.property.city}</p>
			<dl class="grid grid-cols-2 gap-2 text-base">
				<dt class="text-muted-foreground">Loyer</dt><dd class="text-right font-medium">{formatFCFA(v.lease.rent)}</dd>
				<dt class="text-muted-foreground">Charges</dt><dd class="text-right font-medium">{formatFCFA(v.lease.charges)}</dd>
				<dt class="text-muted-foreground">Caution versée</dt><dd class="text-right font-medium">{formatFCFA(v.lease.deposit)}</dd>
				<dt class="text-muted-foreground">Depuis le</dt><dd class="text-right font-medium">{formatDate(v.lease.startDate)}</dd>
			</dl>
			<div class="grid grid-cols-1 gap-2">
				<Button variant="outline" href="/locataire/recus" class="w-full"><Receipt aria-hidden="true" /> Mes reçus</Button>
				<Button variant="outline" href="/locataire/caution" class="w-full"><ShieldCheck aria-hidden="true" /> Ma caution</Button>
			</div>
		</section>
		{#if past.length}
			<a href="/locataire/historique" class="flex min-h-16 items-center gap-3 rounded-xl border bg-card p-4 hover:bg-accent" data-testid="lien-historique">
				<History class="size-6 shrink-0 text-primary" aria-hidden="true" />
				<span class="flex-1">
					<span class="block font-semibold">Mon historique</span>
					<span class="block text-base text-muted-foreground">{past.length} {past.length > 1 ? 'anciens baux' : 'ancien bail'} : {past.map((l) => l.organization.name).join(', ')}</span>
				</span>
				<ChevronRight class="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
			</a>
		{/if}
		<AgencyContact message="Bonjour, c’est {v.tenant.civility} {v.tenant.name} ({v.property.name} — {v.unit.label})." />
	</aside>
</main>
