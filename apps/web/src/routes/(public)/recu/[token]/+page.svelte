<script lang="ts">
	/**
	 * Reçu partagé par WhatsApp ou SMS (lot 09) : le reçu en lecture seule, son PDF, et l'invitation à créer son compte
	 * pour retrouver tout son historique (espace locataire au lot 10 ter, D13). Jeton long et révocable ; un reçu pas
	 * encore synchronisé : « Reçu en cours d'enregistrement », jamais une erreur.
	 */
	import { onMount } from 'svelte';
	import { FileDown, UserPlus } from '@lucide/svelte';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { formatDate } from '@ziga/shared/dates';
	import { formatFcfa } from '@ziga/shared/money';
	import type { SharedReceiptView } from '@ziga/shared/receipts';
	import ReceiptDocumentView from '#lib/components/payments/ReceiptDocumentView.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { ApiError, call } from '#lib/auth/http.ts';
	import { fr } from '#lib/i18n/fr.ts';

	const t = fr.receiptPublic;
	const token = $derived(page.params.token ?? '');
	let view = $state<SharedReceiptView | null>(null);
	let failed = $state<string | null>(null);

	async function load() {
		failed = null;
		try {
			view = await call<SharedReceiptView>('GET', `/public/receipts/shared/${encodeURIComponent(token)}`);
		} catch (error) {
			view = null;
			failed =
				error instanceof ApiError && error.status === 404
					? 'missing'
					: error instanceof ApiError && error.status === 429
						? t.tooMany
						: fr.auth.network;
		}
	}

	onMount(load);

	async function pdf() {
		try {
			const r = await call<{ url: string }>('GET', `/public/receipts/shared/${encodeURIComponent(token)}/pdf?format=a6`);
			window.open(r.url, '_blank', 'noopener');
		} catch {
			failed = fr.auth.network;
		}
	}
</script>

<svelte:head>
	<title>{t.sharedTitle} · {fr.app.name}</title>
	<meta name="robots" content="noindex, nofollow" />
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<main class="mx-auto max-w-lg space-y-4 px-4 py-8" data-testid="recu-partage">
	<h1 class="text-2xl font-bold">{t.sharedTitle}</h1>
	{#if !view && !failed}
		<p class="text-base text-muted-foreground">{t.loading}</p>
	{:else if view?.state === 'pending' || failed === 'missing'}
		<div class="space-y-2 rounded-2xl border bg-card p-5" data-testid="recu-en-cours">
			<p class="text-lg font-semibold">{t.pending}</p>
			<p class="text-base text-muted-foreground">{t.pendingHint}</p>
			<Button variant="outline" onclick={load}>{t.retry}</Button>
		</div>
	{:else if view?.state === 'available'}
		{#if view.document}
			<ReceiptDocumentView document={view.document} />
		{:else}
			<div class="space-y-2 rounded-2xl border bg-card p-5">
				<p class="text-lg font-semibold">{t.provisional}</p>
				<p class="text-base">{view.organizationName}</p>
				<p class="text-base tabular-nums">{view.provisionalNumber} · {formatDate(view.paidOn)} · {formatFcfa(view.amount)}</p>
			</div>
		{/if}
		{#if view.hasPdf}
			<Button variant="outline" class="w-full" onclick={pdf}><FileDown class="size-5" aria-hidden="true" />{t.pdf}</Button>
		{/if}
		<aside class="space-y-2 rounded-2xl border bg-card p-5">
			<p class="text-base">{t.invite}</p>
			<Button
				href={`${resolve('/(auth)/inscription')}?retour=${encodeURIComponent('/espace/liaisons')}`}
				class="w-full"
				data-testid="creer-compte"><UserPlus class="size-5" aria-hidden="true" />{t.inviteAction}</Button
			>
		</aside>
	{:else if failed}
		<p class="text-base">{failed}</p>
	{/if}
</main>
