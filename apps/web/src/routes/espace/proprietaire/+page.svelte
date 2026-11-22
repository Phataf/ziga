<script lang="ts">
	/**
	 * Patrimoine du propriétaire (lot 10 ter, étape 3b) : tous ses biens sur un même écran, groupés par gestionnaire
	 * (agence ou sa propre organisation de bailleur), avec la situation de chaque unité, son loyer, le bail en cours (nom du
	 * locataire seulement, réponse 5) et le détenteur de la caution. Lu en ligne (`/me/portal/owner/assets`), lecture seule.
	 * Téléphone et tablette : cartes ; ordinateur : un tableau par gestionnaire.
	 */
	import { onMount } from 'svelte';
	import { Building2, Phone } from '@lucide/svelte';
	import { formatDate } from '@ziga/shared/dates';
	import { formatFcfa } from '@ziga/shared/money';
	import { formatPhone } from '@ziga/shared/phone';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import RemoteState from '#lib/components/portals/RemoteState.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { assetTotals, unitSituation, type OwnerAssetsOrganization, type OwnerUnit, type UnitSituation } from '#lib/portals/owner.ts';
	import { Remote } from '#lib/portals/remote.svelte.ts';

	const t = fr.ownerSpace;
	const remote = new Remote<{ organizations: OwnerAssetsOrganization[] }>('/me/portal/owner/assets');
	onMount(() => void remote.load());

	const orgs = $derived(remote.data?.organizations ?? []);
	const totals = $derived(assetTotals(orgs));
	const variants: Record<UnitSituation, 'success' | 'info' | 'warning' | 'secondary' | 'outline'> = {
		available: 'success',
		occupied: 'info',
		notice: 'warning',
		reserved: 'secondary',
		unavailable: 'outline'
	};

	function holder(org: OwnerAssetsOrganization, d: NonNullable<OwnerUnit['lease']>['deposit']) {
		if (!d) return '';
		const who = d.holder === 'owner' ? t.holderYou : d.holder === 'organization' ? org.organizationName : (d.holderName ?? '');
		return t.depositHeld(formatFcfa(d.agreedAmount), who);
	}
</script>

{#snippet situation(u: OwnerUnit)}
	{@const s = unitSituation(u)}
	<Badge variant={variants[s]} data-testid="situation-unite" data-situation={s}>{t.situations[s]}</Badge>
{/snippet}

<PageHeader title={t.assetsTitle} subtitle={t.assetsSubtitle} />

<main class="page space-y-6 pt-3 pb-10" data-testid="patrimoine">
	<RemoteState {remote}>
		{#if !orgs.length}
			<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground" data-testid="patrimoine-vide">{t.noAsset}</p>
		{:else}
			<p class="text-base font-medium" data-testid="patrimoine-totaux">{t.totals(totals.properties, totals.units, totals.let)}</p>
			{#each orgs as org (org.organizationId)}
				<section
					class="space-y-3"
					aria-labelledby="gestionnaire-{org.organizationId}"
					data-testid="gestionnaire"
					data-organisation={org.organizationName}
				>
					<div class="flex flex-wrap items-center justify-between gap-3">
						<h2 id="gestionnaire-{org.organizationId}" class="flex min-w-0 items-center gap-2 text-lg font-semibold break-words">
							<Building2 class="size-5 shrink-0" aria-hidden="true" />
							{org.managedBy === 'self' ? t.managedBySelf(org.organizationName) : t.managedByAgency(org.organizationName)}
						</h2>
						{#if org.managedBy === 'agency' && org.organizationPhone}
							<Button variant="outline" href="tel:{org.organizationPhone}" aria-label="{t.contact} ({formatPhone(org.organizationPhone)})">
								<Phone class="size-5" aria-hidden="true" />{t.contact}
							</Button>
						{/if}
					</div>
					{#each org.properties as p (p.id)}
						<article class="space-y-3 rounded-xl border bg-card p-4" data-testid="bien-proprietaire">
							<h3 class="text-base font-semibold break-words">{p.name}</h3>
							{#if !p.units.length}
								<p class="text-base text-muted-foreground">{t.noUnit}</p>
							{:else if device.isDesktop}
								<table class="w-full text-left text-base">
									<thead class="border-b text-muted-foreground">
										<tr>
											<th class="py-2 pr-4 font-medium">{t.unit}</th>
											<th class="py-2 pr-4 font-medium">{t.situation}</th>
											<th class="py-2 pr-4 text-right font-medium">{t.rent}</th>
											<th class="py-2 pr-4 font-medium">{t.tenant}</th>
											<th class="py-2 font-medium">{t.deposit}</th>
										</tr>
									</thead>
									<tbody class="divide-y">
										{#each p.units as u (u.id)}
											<tr data-testid="unite-proprietaire">
												<td class="py-3 pr-4">{u.label}</td>
												<td class="py-3 pr-4">{@render situation(u)}</td>
												<td class="py-3 pr-4 text-right tabular-nums">{formatFcfa(u.lease?.rent ?? u.rent ?? 0)}</td>
												<td class="py-3 pr-4" data-testid="locataire-unite">
													{#if u.lease}{u.lease.tenant.fullName}
														<span class="text-muted-foreground">{t.since(formatDate(u.lease.startsOn))}</span>
													{:else}<span class="text-muted-foreground">{t.noTenant}</span>{/if}
												</td>
												<td class="py-3">{u.lease ? holder(org, u.lease.deposit) : ''}</td>
											</tr>
										{/each}
									</tbody>
								</table>
							{:else}
								<ul class="divide-y">
									{#each p.units as u (u.id)}
										<li class="space-y-1 py-3 first:pt-0 last:pb-0" data-testid="unite-proprietaire">
											<div class="flex flex-wrap items-center justify-between gap-2">
												<span class="font-medium">{u.label}</span>
												{@render situation(u)}
											</div>
											<p class="text-base tabular-nums">{t.perMonth(formatFcfa(u.lease?.rent ?? u.rent ?? 0))}</p>
											<p class="text-base break-words" data-testid="locataire-unite">
												{#if u.lease}{u.lease.tenant.fullName}
													<span class="text-muted-foreground">{t.since(formatDate(u.lease.startsOn))}</span>
												{:else}<span class="text-muted-foreground">{t.noTenant}</span>{/if}
											</p>
											{#if u.lease?.deposit}<p class="text-base break-words text-muted-foreground">
													{t.deposit} : {holder(org, u.lease.deposit)}
												</p>{/if}
										</li>
									{/each}
								</ul>
							{/if}
						</article>
					{/each}
				</section>
			{/each}
		{/if}
	</RemoteState>
</main>
