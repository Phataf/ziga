<script lang="ts">
	/**
	 * Caution et décompte (lot 10 ter, étape 3c) : pour chaque bail, le montant convenu, son détenteur, et le décompte de
	 * sortie proposé par l'organisation (un brouillon n'est jamais montré ; remis en brouillon : « en cours de correction »),
	 * avec ses lignes et leurs justificatifs. Tant qu'il est proposé, le locataire peut dire son désaccord : le décompte
	 * passe « contesté » (une demande à traiter, jamais une écriture au registre).
	 */
	import { onMount } from 'svelte';
	import { FileText, MessageSquareWarning } from '@lucide/svelte';
	import { formatDate } from '@ziga/shared/dates';
	import { formatFcfa } from '@ziga/shared/money';
	import { settlementObservationSchema } from '@ziga/shared/portals';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import RemoteState from '#lib/components/portals/RemoteState.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import Sheet from '#lib/components/ui/sheet/Sheet.svelte';
	import { auth } from '#lib/auth/auth.svelte.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { openSigned, Remote } from '#lib/portals/remote.svelte.ts';
	import { canObserve, type TenantDeposit } from '#lib/portals/tenant.ts';

	const t = fr.tenantSpace;
	const kinds = fr.exit.settlement.kinds;
	const remote = new Remote<TenantDeposit[]>('/me/portal/tenant/deposits');
	onMount(() => void remote.load());
	const deposits = $derived(remote.data ?? []);

	let message = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let busy = $state(false);
	let target = $state<TenantDeposit | null>(null);
	let open = $state(false);
	let observations = $state('');
	let observationError = $state<string | null>(null);

	function holder(d: TenantDeposit) {
		const who = d.holder === 'owner' ? t.holderOwner : d.holder === 'organization' ? d.organizationName : (d.holderName ?? '');
		return t.depositHeld(formatFcfa(d.agreedAmount), who);
	}

	async function proof(d: TenantDeposit, documentId: string) {
		message = null;
		try {
			await openSigned(`/me/portal/documents/${d.organizationId}/${documentId}/download`, { space: 'tenant' });
		} catch (error) {
			message = messageOf(error);
		}
	}

	function startObservation(d: TenantDeposit) {
		target = d;
		observations = '';
		observationError = null;
		open = true;
	}

	async function send(event: SubmitEvent) {
		event.preventDefault();
		const parsed = settlementObservationSchema.safeParse({ observations });
		observationError = parsed.success ? null : (parsed.error.issues[0]?.message ?? null);
		if (!parsed.success || !target?.settlement) return;
		busy = true;
		try {
			await auth.request('POST', `/me/portal/tenant/settlements/${target.organizationId}/${target.settlement.id}/observation`, parsed.data);
			open = false;
			notice = t.observed;
			await remote.load();
		} catch (error) {
			observationError = messageOf(error);
		} finally {
			busy = false;
		}
	}
</script>

<PageHeader title={t.depositTitle} subtitle={t.depositSubtitle} />

<main class="page space-y-4 pt-3 pb-10" data-testid="caution-locataire">
	<FormAlert {message} />
	{#if notice}<p role="status" class="text-base font-medium" data-testid="caution-message">{notice}</p>{/if}
	<RemoteState {remote}>
		{#if !deposits.length}
			<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground" data-testid="caution-vide">{t.noDeposit}</p>
		{/if}
		{#each deposits as d (d.organizationId + d.id)}
			{@const s = d.settlement}
			<article class="space-y-4 rounded-xl border bg-card p-4 md:p-6" data-testid="caution" data-organisation={d.organizationName}>
				<div class="space-y-1">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<h2 class="text-lg font-semibold">{t.deposit}</h2>
						<Badge variant="secondary">{t.depositStatus[d.status] ?? d.status}</Badge>
					</div>
					<p class="text-base break-words">{holder(d)}</p>
					<p class="text-base break-words text-muted-foreground">{d.organizationName}</p>
				</div>
				{#if s}
					<section class="space-y-3 border-t pt-4" aria-label={t.settlement} data-testid="decompte" data-statut={s.status}>
						<div class="flex flex-wrap items-center justify-between gap-2">
							<h3 class="text-base font-semibold">{t.settlement}</h3>
							<Badge variant={s.status === 'disputed' ? 'warning' : s.status === 'proposed' ? 'info' : 'secondary'}>
								{t.settlementStatus[s.status]}
							</Badge>
						</div>
						{#if s.status !== 'in_correction'}
							<p class="text-base text-muted-foreground">
								{t.exitOn(formatDate(s.exitOn))}{#if s.refundDeadline}&nbsp;· {t.refundDeadline(formatDate(s.refundDeadline))}{/if}
							</p>
							{#if s.lines.length}
								<ul class="divide-y">
									{#each s.lines as l (l.id)}
										<li class="space-y-1 py-2" data-testid="ligne-decompte">
											<div class="flex flex-wrap items-baseline justify-between gap-2">
												<span class="break-words">{kinds[l.kind] ?? l.kind}</span>
												<span class="tabular-nums">{formatFcfa(l.amount)}</span>
											</div>
											{#if l.uncovered > 0}<p class="text-base text-muted-foreground">{t.uncovered(formatFcfa(l.uncovered))}</p>{/if}
											{#if l.documentId}
												<Button variant="link" class="px-0" onclick={() => proof(d, l.documentId!)} data-testid="justificatif">
													<FileText class="size-5" aria-hidden="true" />{t.proof}
												</Button>
											{/if}
										</li>
									{/each}
								</ul>
							{:else}
								<p class="text-base">{t.noLines}</p>
							{/if}
							<dl class="grid grid-cols-2 gap-x-4 gap-y-1 text-base">
								<dt class="text-muted-foreground">{t.received}</dt>
								<dd class="text-right tabular-nums">{formatFcfa(s.received)}</dd>
								<dt class="text-muted-foreground">{t.deductions}</dt>
								<dd class="text-right tabular-nums">{formatFcfa(s.deductions)}</dd>
								{#if s.claim > 0}
									<dt class="font-semibold">{t.claim}</dt>
									<dd class="text-right font-semibold tabular-nums" data-testid="decompte-solde">{formatFcfa(s.claim)}</dd>
								{:else}
									<dt class="font-semibold">{t.refund}</dt>
									<dd class="text-right font-semibold tabular-nums" data-testid="decompte-solde">{formatFcfa(s.refund)}</dd>
								{/if}
							</dl>
							{#if s.tenantObservations}
								<div class="rounded-lg bg-muted p-3">
									<p class="text-base font-medium">{t.yourObservation}</p>
									<p class="text-base break-words whitespace-pre-line">{s.tenantObservations}</p>
								</div>
							{/if}
							{#if s.organizationObservations}
								<div class="rounded-lg bg-muted p-3">
									<p class="text-base font-medium">{t.organizationObservation}</p>
									<p class="text-base break-words whitespace-pre-line">{s.organizationObservations}</p>
								</div>
							{/if}
							{#if canObserve(s)}
								<Button variant="outline" onclick={() => startObservation(d)} data-testid="contester-decompte">
									<MessageSquareWarning class="size-5" aria-hidden="true" />{t.observe}
								</Button>
							{/if}
						{/if}
					</section>
				{/if}
			</article>
		{/each}
	</RemoteState>
</main>

<Sheet bind:open labelledby="observation-titre" side="right">
	<form class="space-y-4" onsubmit={send} novalidate data-testid="formulaire-observation">
		<h2 id="observation-titre" class="pr-10 text-xl font-semibold">{t.observeTitle}</h2>
		<p class="text-base text-muted-foreground">{t.observeHelp}</p>
		<label class="block space-y-1">
			<span class="text-base font-medium">{t.observation}</span>
			<textarea
				bind:value={observations}
				rows="5"
				aria-invalid={!!observationError}
				class="w-full rounded-lg border-2 border-input bg-card px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30"
				data-testid="observation"></textarea>
		</label>
		{#if observationError}<p class="text-base text-destructive">{observationError}</p>{/if}
		<Button type="submit" disabled={busy} class="w-full" data-testid="envoyer-observation">{t.send}</Button>
	</form>
</Sheet>
