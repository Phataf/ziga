<script lang="ts">
	/**
	 * Mes contrats (lot 10 ter, étape 3c) : à signer, en vigueur, terminés, toutes organisations confondues ; pour chacun
	 * le logement, l'organisation, le bailleur désigné, les dates, le loyer, la caution, les statuts du bail et du contrat,
	 * la prochaine échéance, et ses documents permis par la matrice (D22), ouverts par un lien signé journalisé.
	 */
	import { onMount } from 'svelte';
	import { FileText } from '@lucide/svelte';
	import { formatDate } from '@ziga/shared/dates';
	import { formatFcfa } from '@ziga/shared/money';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import RemoteState from '#lib/components/portals/RemoteState.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { openSigned, Remote } from '#lib/portals/remote.svelte.ts';
	import { contractGroups, placeLabel, type TenantContract, type TenantDocument } from '#lib/portals/tenant.ts';

	const t = fr.tenantSpace;
	const types = fr.documents.types as Record<string, string>;
	const contracts = new Remote<TenantContract[]>('/me/portal/tenant/contracts');
	const documents = new Remote<TenantDocument[]>('/me/portal/tenant/documents');
	onMount(() => void Promise.all([contracts.load(), documents.load()]));

	const groups = $derived(contractGroups(contracts.data ?? []));
	const docs = $derived(documents.data ?? []);
	const docsOf = (c: TenantContract) => docs.filter((d) => d.organizationId === c.organizationId && d.leaseId === c.leaseId);
	const leaseKeys = $derived(new Set((contracts.data ?? []).map((c) => `${c.organizationId}|${c.leaseId}`)));
	const others = $derived(docs.filter((d) => !d.leaseId || !leaseKeys.has(`${d.organizationId}|${d.leaseId}`)));
	let message = $state<string | null>(null);
	let busy = $state(false);

	async function open(d: TenantDocument) {
		message = null;
		busy = true;
		try {
			await openSigned(`/me/portal/documents/${d.organizationId}/${d.id}/download`, { space: 'tenant' });
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}

	function holder(c: TenantContract) {
		const d = c.deposit!;
		const who = d.holder === 'owner' ? t.holderOwner : d.holder === 'organization' ? c.organizationName : (d.holderName ?? '');
		return t.depositHeld(formatFcfa(d.agreedAmount), who);
	}
</script>

{#snippet documentList(list: TenantDocument[])}
	{#if list.length}
		<ul class="space-y-2">
			{#each list as d (d.id)}
				<li class="flex flex-wrap items-center justify-between gap-2" data-testid="document-locataire" data-type={d.type}>
					<span class="min-w-0 text-base break-words">{types[d.type] ?? d.type}</span>
					<Button variant="outline" onclick={() => open(d)} disabled={busy} data-testid="document-consulter">
						<FileText class="size-5" aria-hidden="true" />{t.open}
					</Button>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="text-base text-muted-foreground">{t.noDocument}</p>
	{/if}
{/snippet}

<PageHeader title={t.contractsTitle} subtitle={t.contractsSubtitle} />

<main class="page space-y-6 pt-3 pb-10" data-testid="contrats-locataire">
	<p class="text-base text-muted-foreground">{t.linkTtl}</p>
	<FormAlert {message} />
	<RemoteState remote={contracts}>
		{#if !groups.length}
			<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground" data-testid="contrats-vide">{t.noContract}</p>
		{/if}
		{#each groups as g (g.group)}
			<section class="space-y-3" aria-labelledby="groupe-{g.group}" data-testid="groupe-contrats" data-groupe={g.group}>
				<h2 id="groupe-{g.group}" class="text-lg font-semibold">{t.groups[g.group]}</h2>
				{#if g.group === 'to_sign'}<p class="text-base text-muted-foreground">{t.toSignHelp}</p>{/if}
				<div class="grid gap-4 lg:grid-cols-2">
					{#each g.contracts as c (c.organizationId + c.leaseId)}
						<article class="space-y-3 rounded-xl border bg-card p-4" data-testid="contrat-locataire" data-organisation={c.organizationName}>
							<div class="space-y-1">
								<h3 class="text-base font-semibold break-words">{placeLabel(c)}</h3>
								<p class="text-base break-words text-muted-foreground">{c.organizationName}</p>
							</div>
							<div class="flex flex-wrap gap-2">
								<Badge variant={c.leaseStatus === 'ended' ? 'outline' : 'info'}
									>{t.leaseStatus} : {fr.leases.status[c.leaseStatus] ?? c.leaseStatus}</Badge
								>
								<Badge variant={c.signed ? 'success' : 'warning'}>
									{t.contractStatus} : {c.signed ? t.signedScan : fr.contracts.status[c.contractStatus ?? 'none']}
								</Badge>
								{#if c.amendments.length}<Badge variant="secondary">{t.amendments(c.amendments.length)}</Badge>{/if}
							</div>
							<dl class="grid grid-cols-1 gap-2 text-base sm:grid-cols-2">
								<div>
									<dt class="text-muted-foreground">{t.lessor}</dt>
									<dd class="break-words">{c.lessorName}</dd>
								</div>
								<div>
									<dt class="text-muted-foreground">{t.period}</dt>
									<dd>{t.fromTo(formatDate(c.startsOn), (c.exitOn ?? c.endsOn) ? formatDate((c.exitOn ?? c.endsOn)!) : null)}</dd>
								</div>
								<div>
									<dt class="text-muted-foreground">{t.rent}</dt>
									<dd class="tabular-nums">{t.perMonth(formatFcfa(c.rent + c.charges))}</dd>
								</div>
								{#if c.deposit}
									<div>
										<dt class="text-muted-foreground">{t.deposit}</dt>
										<dd class="break-words">{holder(c)}</dd>
									</div>
								{/if}
								{#if c.nextDueOn && c.group !== 'ended'}
									<div>
										<dt class="text-muted-foreground">{t.nextDueLabel}</dt>
										<dd>{formatDate(c.nextDueOn)}</dd>
									</div>
								{/if}
							</dl>
							<div class="space-y-2 border-t pt-3">
								<h4 class="text-base font-medium">{t.documents}</h4>
								{#if documents.loading && !documents.data}
									<p class="text-base text-muted-foreground">{fr.ownerSpace.loading}</p>
								{:else}
									{@render documentList(docsOf(c))}
								{/if}
							</div>
						</article>
					{/each}
				</div>
			</section>
		{/each}
		{#if others.length}
			<section class="space-y-3 rounded-xl border bg-card p-4" aria-labelledby="autres-documents">
				<h2 id="autres-documents" class="text-lg font-semibold">{t.otherDocuments}</h2>
				{@render documentList(others)}
			</section>
		{/if}
	</RemoteState>
</main>
