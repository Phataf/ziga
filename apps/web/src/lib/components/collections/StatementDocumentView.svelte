<script lang="ts">
	/**
	 * Relevé propriétaire (lot 10) : le même contenu que le PDF et la page partagée `/s/<jeton>` (`statementDocument`,
	 * packages/shared). Sans état ni script : rendu serveur seul sur `/s`. Un locataire n'y apparaît que par son nom.
	 * Le net négatif n'est jamais un grand montant négatif : un cadre « Solde en faveur de … » avec son explication.
	 */
	import { formatFcfa, formatSignedFcfa } from '@ziga/shared/money';
	import type { StatementDocument, StatementSection } from '@ziga/shared/statements';

	let { document: doc, draftNote }: { document: StatementDocument; draftNote?: string } = $props();

	const tone = $derived(
		doc.headline.tone === 'payout'
			? 'border-primary bg-success-soft'
			: doc.headline.tone === 'owed'
				? 'border-warning bg-warning-soft'
				: 'border-border bg-muted'
	);
</script>

{#snippet section(s: StatementSection, info: boolean)}
	<section class="space-y-2" data-testid={info ? 'releve-info' : 'releve-section'}>
		<h3 class="text-lg font-semibold">{s.title}</h3>
		{#if s.rows.length}
			<ul class="divide-y rounded-xl border bg-card">
				{#each s.rows as r, i (i)}
					<li class="flex items-start justify-between gap-3 px-4 py-3">
						<span class="min-w-0">
							<span class="block break-words">{r.title}</span>
							{#if r.detail}<span class="block text-sm break-words text-muted-foreground">{r.detail}</span>{/if}
						</span>
						<span class="shrink-0 text-right whitespace-nowrap tabular-nums"
							>{info ? formatFcfa(r.amount) : formatSignedFcfa(r.amount)}</span
						>
					</li>
				{/each}
				{#if s.total}
					<li class="flex items-start justify-between gap-3 bg-muted/50 px-4 py-3 font-semibold">
						<span>{s.total.label}</span>
						<span class="shrink-0 whitespace-nowrap tabular-nums"
							>{info ? formatFcfa(s.total.amount) : formatSignedFcfa(s.total.amount)}</span
						>
					</li>
				{/if}
			</ul>
		{/if}
		{#if s.note}<p class="text-sm text-muted-foreground">{s.note}</p>{/if}
	</section>
{/snippet}

<article class="space-y-5" data-testid="releve-document">
	<header class="space-y-1">
		<h2 class="text-xl font-bold break-words">{doc.title}</h2>
		<p class="text-base break-words">{doc.owner}</p>
		<p class="text-sm text-muted-foreground">{doc.period}</p>
		{#if doc.organization.length}
			<p class="text-sm break-words text-muted-foreground">{doc.organization.join(' · ')}</p>
		{/if}
		{#if doc.draft && draftNote}<p class="text-sm font-medium text-warning-foreground" data-testid="releve-brouillon">{draftNote}</p>{/if}
	</header>

	<div class="space-y-1 rounded-xl border-2 p-4 {tone}" data-testid="releve-net" data-tone={doc.headline.tone}>
		<p class="text-base font-medium">{doc.headline.label}</p>
		<p class="text-2xl font-bold tabular-nums">{formatFcfa(doc.headline.amount)}</p>
		{#if doc.headline.explanation}<p class="text-sm">{doc.headline.explanation}</p>{/if}
	</div>

	{#each doc.sections as s, i (i)}{@render section(s, false)}{/each}
	{#each doc.info as s, i (i)}{@render section(s, true)}{/each}
</article>
