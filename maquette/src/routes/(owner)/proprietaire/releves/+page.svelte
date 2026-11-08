<script lang="ts">
	import { page } from '$app/state';
	import { Printer } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import StatementDocument from '$lib/components/StatementDocument.svelte';
	import { Button } from '$lib/components/ui/button';
	import { demo } from '$lib/demo.svelte';
	import { personLinks } from '$lib/fixtures-orgs';
	import { formatFCFA, formatMonthTitle } from '$lib/format';
	import { cn } from '$lib/utils';
	import { ownerStatement } from '$lib/views';

	function shift(period: string, delta: number) {
		const d = new Date(+period.slice(0, 4), +period.slice(5, 7) - 1 + delta, 1);
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
	}

	const current = $derived(demo.today.slice(0, 7));
	const months = $derived([0, 1, 2].map((i) => shift(current, -i)));
	let chosen = $state<string | null>(null);
	const period = $derived(chosen ?? page.url.searchParams.get('mois') ?? shift(current, -1));
	/** Chaque agence envoie ses propres relevés ; la gestion directe n'en a pas. */
	const agencies = $derived(
		personLinks
			.filter((l) => l.personId === demo.ownerPerson.id && l.kind === 'owner' && demo.orgs[l.organizationId]?.agency.kind === 'agency')
			.map((l) => ({ data: demo.orgs[l.organizationId], ownerId: l.recordId }))
	);
	let orgId = $state('agency-demo');
	const chosenOrg = $derived(agencies.find((a) => a.data.agency.id === orgId) ?? agencies[0]);
	const st = $derived(ownerStatement(chosenOrg.data, chosenOrg.ownerId, period)!);
</script>

<PageHeader title="Mes relevés" subtitle="Envoyés chaque mois par chacune de vos agences" />

<div class="page pt-3">
	<div class="flex gap-2 overflow-x-auto" role="group" aria-label="Choisir l’agence">
		{#each agencies as a (a.data.agency.id)}
			<button
				type="button"
				class={cn('min-h-11 shrink-0 rounded-full border-2 px-4 font-medium', orgId === a.data.agency.id ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card hover:bg-accent')}
				aria-pressed={orgId === a.data.agency.id}
				onclick={() => (orgId = a.data.agency.id)}
			>
				{a.data.agency.name}
			</button>
		{/each}
	</div>
</div>

<main class="page space-y-4 pt-3 md:grid md:grid-cols-[16rem_minmax(0,1fr)] md:items-start md:gap-6 md:space-y-0">
	<!-- Téléphone : choix du mois en boutons. Tablette et ordinateur : liste des mois à gauche, document à droite. -->
	<nav aria-label="Choisir le mois" class="flex gap-2 overflow-x-auto md:flex-col md:rounded-xl md:border md:bg-card md:p-2">
		{#each months as m (m)}
			{@const s = ownerStatement(chosenOrg.data, chosenOrg.ownerId, m)!}
			<button
				type="button"
				class={cn(
					'min-h-11 shrink-0 rounded-lg border-2 px-3 text-left font-medium md:border-0 md:py-2',
					period === m ? 'border-primary bg-primary text-primary-foreground md:bg-secondary md:text-secondary-foreground' : 'border-input bg-card hover:bg-accent'
				)}
				aria-pressed={period === m}
				onclick={() => (chosen = m)}
			>
				<span class="block">{formatMonthTitle(m)}{m === current ? ' (en cours)' : ''}</span>
				<span class="hidden text-base opacity-80 md:block">Net {formatFCFA(s.totals.net)}</span>
			</button>
		{/each}
	</nav>
	<div class="space-y-3">
		<StatementDocument {st} {period} agencyName={chosenOrg.data.agency.name} />
		<Button variant="outline" onclick={() => window.print()} class="print:hidden"><Printer aria-hidden="true" /> Imprimer ou enregistrer en PDF</Button>
	</div>
</main>
