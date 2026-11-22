<script lang="ts">
	/**
	 * Relevés du propriétaire (lot 10 ter, étape 3b) : les relevés émis par chacun de ses gestionnaires, avec le net,
	 * le reversé et le reste ; le PDF s'ouvre par un lien signé de 5 minutes, chaque téléchargement est journalisé dans
	 * l'organisation. Téléphone et tablette : cartes ; ordinateur : tableau.
	 */
	import { onMount } from 'svelte';
	import { Download } from '@lucide/svelte';
	import { formatDate } from '@ziga/shared/dates';
	import { formatFcfa, formatSignedFcfa } from '@ziga/shared/money';
	import { monthLabel } from '@ziga/shared/statements';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import RemoteState from '#lib/components/portals/RemoteState.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import type { OwnerStatement } from '#lib/portals/owner.ts';
	import { openSigned, Remote } from '#lib/portals/remote.svelte.ts';

	const t = fr.ownerSpace;
	const remote = new Remote<OwnerStatement[]>('/me/portal/owner/statements');
	onMount(() => void remote.load());
	const rows = $derived(remote.data ?? []);
	let message = $state<string | null>(null);
	let busy = $state<string | null>(null);

	async function pdf(s: OwnerStatement) {
		message = null;
		busy = s.id;
		try {
			await openSigned(`/me/portal/owner/statements/${s.organizationId}/${s.id}/pdf`);
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = null;
		}
	}
</script>

{#snippet download(s: OwnerStatement)}
	{#if s.pdfAvailable}
		<Button variant="outline" onclick={() => pdf(s)} disabled={busy !== null} data-testid="releve-pdf">
			<Download class="size-5" aria-hidden="true" />{t.pdf}
		</Button>
	{:else}
		<span class="text-base text-muted-foreground">{t.pdfPending}</span>
	{/if}
{/snippet}

<PageHeader title={t.statementsTitle} subtitle={t.statementsSubtitle} />

<main class="page space-y-4 pt-3 pb-10" data-testid="releves-proprietaire">
	<RemoteState {remote}>
		<FormAlert {message} />
		{#if !rows.length}
			<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground" data-testid="releves-vide">{t.noStatement}</p>
		{:else if device.isDesktop}
			<div class="overflow-x-auto rounded-xl border bg-card">
				<table class="w-full text-left text-base">
					<thead class="border-b text-muted-foreground">
						<tr>
							<th class="px-4 py-3 font-medium">{t.month}</th>
							<th class="px-4 py-3 font-medium">{t.manager}</th>
							<th class="px-4 py-3 text-right font-medium">{t.collected}</th>
							<th class="px-4 py-3 text-right font-medium">{t.net}</th>
							<th class="px-4 py-3 text-right font-medium">{t.paidOut}</th>
							<th class="px-4 py-3 text-right font-medium">{t.remaining}</th>
							<th class="px-4 py-3"><span class="sr-only">{t.pdf}</span></th>
						</tr>
					</thead>
					<tbody class="divide-y">
						{#each rows as s (s.id)}
							<tr data-testid="releve">
								<td class="px-4 py-3">
									{monthLabel(s.month)}
									{#if s.version > 1}<span class="text-muted-foreground">({t.version(s.version)})</span>{/if}
								</td>
								<td class="px-4 py-3">{s.organizationName}</td>
								<td class="px-4 py-3 text-right tabular-nums">{formatFcfa(s.collected)}</td>
								<td class="px-4 py-3 text-right font-semibold tabular-nums">{formatSignedFcfa(s.net)}</td>
								<td class="px-4 py-3 text-right tabular-nums">{formatFcfa(s.paidOut)}</td>
								<td class="px-4 py-3 text-right tabular-nums">{formatFcfa(s.remaining)}</td>
								<td class="px-4 py-3 text-right">{@render download(s)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<ul class="space-y-3">
				{#each rows as s (s.id)}
					<li class="space-y-2 rounded-xl border bg-card p-4" data-testid="releve">
						<div class="flex flex-wrap items-baseline justify-between gap-2">
							<span class="font-semibold">
								{monthLabel(s.month)}
								{#if s.version > 1}<span class="font-normal text-muted-foreground">({t.version(s.version)})</span>{/if}
							</span>
							<span class="font-semibold tabular-nums">{formatSignedFcfa(s.net)}</span>
						</div>
						<p class="text-base break-words text-muted-foreground">
							{s.organizationName}{#if s.issuedOn}&nbsp;· {t.issuedOn(formatDate(s.issuedOn))}{/if}
						</p>
						<p class="text-base tabular-nums">
							{t.paidOut}
							{formatFcfa(s.paidOut)} · {t.remaining}
							{formatFcfa(s.remaining)}
						</p>
						{@render download(s)}
					</li>
				{/each}
			</ul>
		{/if}
	</RemoteState>
</main>
