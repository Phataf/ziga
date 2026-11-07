<script lang="ts">
	import { page } from '$app/state';
	import { Check, Send } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import StatementDocument from '$lib/components/StatementDocument.svelte';
	import { Button } from '$lib/components/ui/button';
	import { demo } from '$lib/demo.svelte';
	import { formatDate, formatMonthTitle } from '$lib/format';
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
	// Le lien ouvre l'espace propriétaire, sans compte (dans le produit : jeton d'accès révocable).
	const link = $derived(st ? `${page.url.origin}/proprietaire/releves?mois=${period}` : '');
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
	<main class="page space-y-4 pt-3 md:grid md:grid-cols-[minmax(0,1fr)_20rem] md:items-start md:gap-6 md:space-y-0 xl:grid-cols-[minmax(0,1fr)_22rem]">
		<div class="space-y-4">
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

		<StatementDocument {st} {period} agencyName={demo.data.agency.name} />
		</div>

		<!-- Tablette et ordinateur : panneau d’envoi collant à droite du document. -->
		<aside class="space-y-3 md:sticky md:top-20 md:rounded-xl md:border md:bg-card md:p-4">
		<p class="hidden font-semibold md:block">Envoyer au propriétaire</p>

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
		<p class="text-center text-base text-muted-foreground md:text-left">Le propriétaire n’a pas besoin de compte : il ouvre le lien.</p>
		</aside>
	</main>
{/if}
