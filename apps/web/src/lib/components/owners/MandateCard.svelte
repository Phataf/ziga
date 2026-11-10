<script lang="ts">
	/**
	 * Un mandat (lot 06) : statut effectif (à venir, en vigueur, expiré, révoqué), période, commission, autorisations
	 * en vigueur, version ; alerte à 30 jours de la fin ; actions selon le rôle.
	 */
	import { CircleAlert, History, Pencil, Ban } from '@lucide/svelte';
	import { formatDate } from '@ziga/shared/dates';
	import { formatFcfa } from '@ziga/shared/money';
	import { effectiveAuthorizations, formatRateBp, mandateAlert, MANDATE_AUTHORIZATIONS, type MandateView } from '@ziga/shared/owners';
	import { Badge, type BadgeVariant } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { badgeOf } from '#lib/owners/views.ts';

	let {
		mandate,
		today,
		manage = false,
		onedit,
		onrevoke,
		onhistory
	}: {
		mandate: MandateView;
		today: string;
		manage?: boolean;
		onedit?: () => void;
		onrevoke?: () => void;
		onhistory?: () => void;
	} = $props();
	const t = fr.mandates;

	const status = $derived(badgeOf(mandate, today));
	const variant = $derived<BadgeVariant>(
		status === 'active' ? 'success' : status === 'upcoming' ? 'info' : status === 'revoked' ? 'danger' : 'secondary'
	);
	const alert = $derived(mandateAlert(mandate, today));
	const granted = $derived(MANDATE_AUTHORIZATIONS.filter((a) => effectiveAuthorizations(mandate, today)[a]));
	const commission = $derived.by(() => {
		const c = mandate.commission;
		if (!c) return t.noCommission;
		return c.basis === 'percent_of_collected'
			? t.commissionText[c.basis]!(formatRateBp(c.rateBp))
			: t.commissionText[c.basis]!(formatFcfa(c.amount));
	});
	const open = $derived(mandate.status === 'active' && mandate.type !== 'self_managed' && status !== 'expired');
</script>

<article class="space-y-3 rounded-xl border bg-card p-4" data-testid="mandat" data-statut={status}>
	<div class="flex flex-wrap items-start justify-between gap-2">
		<div class="min-w-0">
			<h3 class="font-semibold">{t.types[mandate.type]}</h3>
			<p class="text-sm text-muted-foreground">{t.version(mandate.version)}</p>
		</div>
		<Badge {variant} data-testid="statut-mandat">{t.statuses[status]}</Badge>
	</div>
	{#if alert}
		<p class="flex items-start gap-2 rounded-lg bg-warning-soft p-3 text-base text-warning-foreground" data-testid="alerte-fin">
			<CircleAlert class="mt-0.5 size-5 shrink-0" aria-hidden="true" />{t.endsSoon(alert.daysLeft, formatDate(mandate.endsOn!))}
		</p>
	{/if}
	<p class="text-base">{t.period(formatDate(mandate.startsOn), mandate.endsOn ? formatDate(mandate.endsOn) : null)}</p>
	{#if mandate.type === 'self_managed'}
		<p class="text-base text-muted-foreground">{t.permanent}</p>
	{:else}
		<p class="text-base"><span class="font-medium">{t.commission} :</span> {commission}</p>
	{/if}
	<div>
		<p class="font-medium">{t.authorizations}</p>
		{#if granted.length}
			<ul class="mt-1 list-inside list-disc text-base" data-testid="autorisations">
				{#each granted as a (a)}<li>{t.authorization[a]}</li>{/each}
				{#if mandate.exclusive}<li>{t.exclusive}</li>{/if}
			</ul>
		{:else}
			<p class="text-base text-muted-foreground" data-testid="autorisations">{t.noAuthorization}</p>
		{/if}
	</div>
	{#if mandate.status === 'revoked' && mandate.revocationReason}
		<p class="text-base">{t.revokedBecause(mandate.revocationReason)}</p>
	{/if}
	<div class="flex flex-wrap gap-2">
		{#if manage && open}
			<Button variant="outline" onclick={onedit}><Pencil aria-hidden="true" />{t.edit}</Button>
			<Button variant="outline" onclick={onrevoke}><Ban aria-hidden="true" />{t.revoke}</Button>
		{/if}
		<Button variant="ghost" onclick={onhistory}><History aria-hidden="true" />{t.history}</Button>
	</div>
</article>
