<script lang="ts">
	/**
	 * Mon logement (lot 10 ter, étape 3c) : chaque bail en cours (en vigueur ou en préavis), toutes organisations
	 * confondues, avec son solde, sa prochaine échéance et le contact de l'organisation. « Payer par Mobile Money » est
	 * désactivé, avec l'explication, tant que `payments.direct` est coupée pour l'organisation (décidé par le serveur).
	 */
	import { onMount } from 'svelte';
	import { Phone, Smartphone } from '@lucide/svelte';
	import { formatDate } from '@ziga/shared/dates';
	import { formatFcfa } from '@ziga/shared/money';
	import { formatPhone } from '@ziga/shared/phone';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import RemoteState from '#lib/components/portals/RemoteState.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { Remote } from '#lib/portals/remote.svelte.ts';
	import { placeLabel, type TenantHome } from '#lib/portals/tenant.ts';

	const t = fr.tenantSpace;
	const remote = new Remote<{ homes: TenantHome[] }>('/me/portal/tenant/home');
	onMount(() => void remote.load());
	const homes = $derived(remote.data?.homes ?? []);
</script>

<PageHeader title={t.homeTitle} subtitle={t.homeSubtitle} />

<main class="page space-y-4 pt-3 pb-10" data-testid="logement">
	<RemoteState {remote}>
		{#if !homes.length}
			<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground" data-testid="logement-vide">{t.noHome}</p>
		{:else}
			<div class="grid gap-4 lg:grid-cols-2">
				{#each homes as h (h.organizationId + h.leaseId)}
					<article
						class="space-y-4 rounded-xl border bg-card p-4 md:p-6"
						data-testid="logement-actuel"
						data-organisation={h.organizationName}
					>
						<div class="space-y-1">
							<div class="flex flex-wrap items-center gap-2">
								<h2 class="text-lg font-semibold break-words">{placeLabel(h)}</h2>
								{#if h.status === 'notice'}<Badge variant="warning">{t.inNotice}</Badge>{/if}
							</div>
							<p class="text-base break-words text-muted-foreground">{t.managedBy(h.organizationName)}</p>
						</div>
						<dl class="grid grid-cols-1 gap-3 text-base sm:grid-cols-3">
							<div>
								<dt class="text-muted-foreground">{t.rent}</dt>
								<dd class="font-medium tabular-nums">{t.perMonth(formatFcfa(h.rent + h.charges))}</dd>
							</div>
							<div>
								<dt class="text-muted-foreground">{t.balance}</dt>
								<dd class="font-semibold tabular-nums" data-testid="solde">{h.balance > 0 ? formatFcfa(h.balance) : t.upToDate}</dd>
							</div>
							<div>
								<dt class="text-muted-foreground">{t.nextDue}</dt>
								<dd class="tabular-nums" data-testid="prochaine-echeance">
									{h.nextDue ? t.nextDueOn(formatDate(h.nextDue.dueOn), formatFcfa(h.nextDue.remaining)) : t.noNextDue}
								</dd>
							</div>
						</dl>
						<div class="space-y-2">
							<Button disabled={!h.directPayment.enabled} aria-describedby="paiement-{h.leaseId}" data-testid="payer-mobile-money">
								<Smartphone class="size-5" aria-hidden="true" />{t.payMobileMoney}
							</Button>
							{#if h.directPayment.reason}
								<p id="paiement-{h.leaseId}" class="text-base text-muted-foreground" data-testid="paiement-explication">
									{h.directPayment.reason}
								</p>
							{/if}
						</div>
						{#if h.organizationPhone}
							<Button variant="outline" href="tel:{h.organizationPhone}" aria-label="{t.contact} ({formatPhone(h.organizationPhone)})">
								<Phone class="size-5" aria-hidden="true" />{t.contact}
							</Button>
						{/if}
					</article>
				{/each}
			</div>
		{/if}
	</RemoteState>
</main>
