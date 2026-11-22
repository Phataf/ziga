<script lang="ts">
	/**
	 * Vérification d'un reçu (QR code imprimé, lot 09) : organisation, numéro, date, montant et statut, et rien d'autre
	 * (aucune donnée personnelle). Un reçu pas encore synchronisé : « en cours d'enregistrement ». Lot 10 ter : propose de
	 * créer un compte, puis de lier sa fiche (« Mes fiches liées »).
	 */
	import { onMount } from 'svelte';
	import { CircleCheck, CircleX, Clock, UserPlus } from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { formatDate } from '@ziga/shared/dates';
	import { formatFcfa } from '@ziga/shared/money';
	import type { ReceiptVerificationView } from '@ziga/shared/receipts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { ApiError, call } from '#lib/auth/http.ts';
	import { fr } from '#lib/i18n/fr.ts';

	const t = fr.receiptPublic;
	let view = $state<ReceiptVerificationView | null>(null);
	let phase = $state<'loading' | 'found' | 'missing' | 'error'>('loading');

	onMount(async () => {
		try {
			view = await call<ReceiptVerificationView>('GET', `/public/receipts/verify/${encodeURIComponent(page.params.token ?? '')}`);
			phase = 'found';
		} catch (error) {
			phase = error instanceof ApiError && error.status === 404 ? 'missing' : 'error';
		}
	});
</script>

<svelte:head>
	<title>{t.verifyTitle} · {fr.app.name}</title>
	<meta name="robots" content="noindex, nofollow" />
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<main class="mx-auto max-w-md space-y-4 px-4 py-8" data-testid="verification-recu">
	<h1 class="text-2xl font-bold">{t.verifyTitle}</h1>
	{#if phase === 'loading'}
		<p class="text-base text-muted-foreground">{t.loading}</p>
	{:else if phase === 'found' && view}
		<div class="space-y-4 rounded-2xl border bg-card p-5" data-statut={view.status}>
			<p class="flex items-center gap-2 text-xl font-semibold" data-testid="statut-verification">
				{#if view.status === 'valid'}<CircleCheck class="size-6 text-primary" aria-hidden="true" />{t.valid}
				{:else if view.status === 'cancelled'}<CircleX class="size-6 text-destructive" aria-hidden="true" />{t.cancelled}
				{:else}<Clock class="size-6 text-muted-foreground" aria-hidden="true" />{t.provisional}{/if}
			</p>
			<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-base">
				<dt class="text-muted-foreground">{t.organization}</dt>
				<dd class="font-medium break-words">{view.organizationName}</dd>
				<dt class="text-muted-foreground">{t.number}</dt>
				<dd class="font-medium tabular-nums" data-testid="numero-verifie">{view.number ?? '—'}</dd>
				<dt class="text-muted-foreground">{t.date}</dt>
				<dd class="tabular-nums">{view.issuedOn ? formatDate(view.issuedOn) : '—'}</dd>
				<dt class="text-muted-foreground">{t.amount}</dt>
				<dd class="font-semibold tabular-nums">{formatFcfa(view.amount)}</dd>
			</dl>
		</div>
		<aside class="space-y-2 rounded-2xl border bg-card p-5">
			<p class="text-base">{t.invite}</p>
			<Button
				href={`${resolve('/(auth)/inscription')}?retour=${encodeURIComponent('/espace/liaisons')}`}
				class="w-full"
				data-testid="creer-compte"><UserPlus class="size-5" aria-hidden="true" />{t.inviteAction}</Button
			>
		</aside>
	{:else if phase === 'missing'}
		<div class="space-y-1 rounded-2xl border bg-card p-5">
			<p class="text-lg font-semibold">{t.pending}</p>
			<p class="text-base text-muted-foreground">{t.pendingHint}</p>
		</div>
	{:else}
		<p class="text-base">{fr.auth.network}</p>
	{/if}
</main>
