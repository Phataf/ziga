<script lang="ts">
	/**
	 * Relevé propriétaire partagé (lot 10) : le relevé émis, en lecture seule, le lien vers son PDF, puis l'invitation à
	 * créer son compte pour retrouver tous ses biens (espace propriétaire, D13). Rendu serveur, sans JavaScript. Un
	 * locataire n'y apparaît que par son nom : ni téléphone, ni pièce d'identité.
	 */
	import { FileDown, UserPlus } from '@lucide/svelte';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { formatDate } from '@ziga/shared/dates';
	import StatementDocumentView from '#lib/components/collections/StatementDocumentView.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import type { PageProps } from './$types';

	let { data, params }: PageProps = $props();
	const t = fr.statementPublic;
	const pdfMissing = $derived(page.url.searchParams.get('pdf') === 'indisponible');
</script>

<svelte:head>
	<title>{t.title} · {fr.app.name}</title>
	<meta name="robots" content="noindex, nofollow" />
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<main class="mx-auto max-w-2xl space-y-4 px-4 py-6" data-testid="releve-partage">
	{#if data.state === 'ok'}
		{#if data.view.issuedOn}<p class="text-sm text-muted-foreground">{t.issuedOn(formatDate(data.view.issuedOn))}</p>{/if}
		<StatementDocumentView document={data.view.document} />
		{#if pdfMissing}<p class="text-base" role="status">{fr.statements.pdfPending}</p>{/if}
		{#if data.view.pdfAvailable}
			<Button variant="outline" class="w-full" href={resolve('/(public)/s/[token]/pdf', { token: params.token })} rel="nofollow"
				><FileDown class="size-5" aria-hidden="true" />{t.pdf}</Button
			>
		{/if}
		<aside class="space-y-2 rounded-2xl border bg-card p-5">
			<p class="text-base">{t.invite}</p>
			<Button href={resolve('/(auth)/inscription')} class="w-full"><UserPlus class="size-5" aria-hidden="true" />{t.inviteAction}</Button>
		</aside>
	{:else}
		<h1 class="text-2xl font-bold">{t.title}</h1>
		<div class="space-y-2 rounded-2xl border bg-card p-5" data-testid="releve-introuvable">
			{#if data.state === 'missing'}
				<p class="text-lg font-semibold">{t.notFound}</p>
				<p class="text-base text-muted-foreground">{t.notFoundHint}</p>
			{:else}
				<p class="text-base">{data.state === 'tooMany' ? t.tooMany : t.network}</p>
			{/if}
		</div>
	{/if}
</main>
