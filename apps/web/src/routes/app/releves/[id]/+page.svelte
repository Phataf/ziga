<script lang="ts">
	/**
	 * Un relevé propriétaire (lot 10) : le document lu sur l'appareil (le même que le PDF et la page `/s`), puis les
	 * actions, toutes en ligne : recalculer et émettre un brouillon (empreinte vérifiée par le serveur), PDF, lien partagé
	 * envoyé par WhatsApp au propriétaire, révocation des liens, rectificatif, reversements (enregistrés, jamais
	 * exécutés par la plateforme, règle 5) et leur annulation motivée. Téléphone : actions sous le document ;
	 * ordinateur et tablette : panneau d'actions à droite.
	 */
	import { onMount } from 'svelte';
	import { ArrowLeft, Download, Link, MessageCircle } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { formatDate, toIsoDate } from '@ziga/shared/dates';
	import { newId } from '@ziga/shared/ids';
	import { formatFcfa, parseFcfa } from '@ziga/shared/money';
	import { can } from '@ziga/shared/permissions';
	import { waMeLink } from '@ziga/shared/reminders';
	import {
		cancelPayoutSchema,
		monthLabel,
		PAYOUT_METHODS,
		payoutRemaining,
		payoutSchema,
		payoutsTotal,
		type PayoutMethod,
		type StatementDetailView,
		type StatementShareLinkView
	} from '@ziga/shared/statements';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import StatementDocumentView from '#lib/components/collections/StatementDocumentView.svelte';
	import FeatureGate from '#lib/components/FeatureGate.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import Sheet from '#lib/components/ui/sheet/Sheet.svelte';
	import { messageOf } from '#lib/auth/forms.ts';
	import { documentOf, toStatement, type LocalStatement } from '#lib/collections/views.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';

	type Row = Record<string, unknown>;
	const t = fr.statements;
	const today = toIsoDate();
	const role = $derived(organizations.active?.role);
	const id = $derived(page.params.id ?? '');

	let local = $state<LocalStatement | null>(null);
	/**
	 * Relevé lu par l'API tant que l'appareil n'a pas reçu sa dernière version (brouillon tout juste préparé, émission,
	 * rectificatif) : jamais « introuvable » ni un état dépassé pendant la synchronisation.
	 */
	let remote = $state<StatementDetailView | null>(null);
	let remoteState = $state<'idle' | 'loading' | 'failed'>('idle');
	let all = $state<LocalStatement[]>([]);
	let payouts = $state<Row[]>([]);
	let owners = $state<Row[]>([]);
	let loaded = $state(false);
	let message = $state<string | null>(null);
	let info = $state<string | null>(null);
	let busy = $state(false);

	onMount(() => {
		const org = organizations.activeId;
		const onError = (error: Error) => (message = messageOf(error));
		const stops = [
			sync.watch<Row>(LOCAL_QUERIES.statement, [org, id], (r) => ((local = r[0] ? toStatement(r[0]) : null), (loaded = true)), onError),
			sync.watch<Row>(LOCAL_QUERIES.statements, [org], (r) => (all = r.map(toStatement)), onError),
			sync.watch<Row>(LOCAL_QUERIES.statementPayouts, [org, id], (r) => (payouts = r), onError),
			sync.watch<Row>(LOCAL_QUERIES.owners, [org], (r) => (owners = r), onError)
		];
		return () => stops.forEach((s) => s());
	});

	$effect(() => {
		if (!loaded || local || remote || remoteState !== 'idle' || !sync.online) return;
		remoteState = 'loading';
		organizations
			.call<StatementDetailView>('GET', `/owner-statements/${id}`)
			.then((v) => ((remote = v), (remoteState = 'idle')))
			.catch((error) => ((message = messageOf(error)), (remoteState = 'failed')));
	});
	// La copie locale a rattrapé l'API : elle reprend la main (mises à jour suivantes comprises).
	$effect(() => {
		if (remote && local && local.status === remote.status && local.revision === remote.revision) remote = null;
	});
	const statement = $derived<LocalStatement | null>(
		remote
			? {
					id: remote.id,
					ownerId: remote.ownerId,
					ownerName: remote.ownerName,
					month: remote.month,
					version: remote.version,
					correctsStatementId: remote.correctsStatementId,
					status: remote.status,
					revision: remote.revision,
					net: remote.totals.net,
					issuedOn: remote.issuedOn,
					pdfAvailable: remote.pdfAvailable,
					snapshot: null
				}
			: local
	);
	const doc = $derived(remote ? remote.document : local ? documentOf(local) : null);
	const owner = $derived(statement ? owners.find((o) => o.id === statement!.ownerId) : undefined);
	const issued = $derived(statement?.status === 'issued');
	/** Seule la dernière version émise d'un mois se rectifie. */
	const latestVersion = $derived(
		statement
			? Math.max(
					statement.version,
					...all.filter((s) => s.ownerId === statement!.ownerId && s.month === statement!.month).map((s) => s.version)
				)
			: 0
	);
	const payoutRows = $derived(
		payouts.map((p) => ({
			id: String(p.id),
			kind: p.kind === 'reversal' ? ('reversal' as const) : ('payout' as const),
			reverses: p.reverses_payout_id ? String(p.reverses_payout_id) : null,
			amount: Number(p.amount),
			paidOn: String(p.paid_on),
			method: String(p.method),
			reference: p.reference ? String(p.reference) : null,
			reason: p.reason ? String(p.reason) : null
		}))
	);
	const reversed = $derived(new Set(payoutRows.filter((p) => p.reverses).map((p) => p.reverses)));
	const paidOut = $derived(payoutsTotal(payoutRows));
	const remaining = $derived(statement ? payoutRemaining(statement.net, paidOut) : 0);

	async function run<T>(fn: () => Promise<T>, done?: (value: T) => void | Promise<void>) {
		busy = true;
		message = null;
		info = null;
		try {
			const value = await fn();
			await done?.(value);
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}

	const recompute = () =>
		run(
			() =>
				organizations.call<StatementDetailView>('POST', '/owner-statements/generate', {
					ownerId: statement!.ownerId,
					month: statement!.month
				}),
			(s) => (s.id !== id ? goto(resolve('/app/releves/[id]', { id: s.id })) : void (remote = s))
		);
	const issue = () =>
		run(
			() => organizations.call<StatementDetailView>('POST', `/owner-statements/${id}/issue`, { revision: statement!.revision }),
			(s) => {
				remote = s;
				info = t.issued;
			}
		);
	const rectify = () =>
		run(
			() => organizations.call<StatementDetailView>('POST', `/owner-statements/${id}/rectify`),
			(s) => goto(resolve('/app/releves/[id]', { id: s.id }))
		);
	const pdf = () =>
		run(
			() => organizations.call<{ url: string }>('GET', `/owner-statements/${id}/pdf`),
			(r) => void window.open(r.url, '_blank', 'noopener')
		);

	// ---- partage : un lien par envoi, ouvert dans WhatsApp vers le téléphone du propriétaire (ou copié).
	let shared = $state<StatementShareLinkView | null>(null);
	const shareText = (url: string) =>
		t.shareMessage(String(owner?.name ?? statement?.ownerName ?? ''), doc?.title ?? '', url, organizations.active?.name ?? '');
	const ownerPhone = $derived(String(owner?.representative_phone || owner?.phone || ''));
	const share = () =>
		run(
			() => organizations.call<StatementShareLinkView>('POST', `/owner-statements/${id}/share-token`),
			(link) => {
				shared = link;
				if (ownerPhone.startsWith('+')) window.open(waMeLink(ownerPhone, shareText(link.url)), '_blank', 'noopener');
			}
		);
	const copy = () =>
		run(
			async () => {
				const link = shared ?? (await organizations.call<StatementShareLinkView>('POST', `/owner-statements/${id}/share-token`));
				shared = link;
				await navigator.clipboard.writeText(link.url);
			},
			() => {
				info = t.linkCopied;
			}
		);
	const revoke = () =>
		run(
			() => organizations.call<{ revoked: number }>('POST', `/owner-statements/${id}/share-token/revoke`),
			(r) => {
				shared = null;
				info = t.revoked(r.revoked);
			}
		);

	// ---- reversements
	let payoutOpen = $state(false);
	let payoutMessage = $state<string | null>(null);
	let amount = $state('');
	let paidOn = $state(today);
	let method = $state<PayoutMethod>('mobile_money');
	let reference = $state('');
	function openPayout() {
		payoutMessage = null;
		amount = String(remaining);
		paidOn = today;
		method = 'mobile_money';
		reference = '';
		payoutOpen = true;
	}
	async function savePayout(e: SubmitEvent) {
		e.preventDefault();
		const parsed = payoutSchema.safeParse({
			id: newId(),
			statementId: id,
			amount: parseFcfa(amount) ?? Number.NaN,
			paidOn,
			method,
			reference
		});
		if (!parsed.success) {
			payoutMessage = parsed.error.issues[0]?.message ?? null;
			return;
		}
		busy = true;
		try {
			await organizations.call('POST', '/owner-payouts', parsed.data);
			payoutOpen = false;
			info = t.payoutSaved;
		} catch (error) {
			payoutMessage = messageOf(error);
		} finally {
			busy = false;
		}
	}

	let cancelOf = $state<string | null>(null);
	let cancelOpen = $state(false);
	let reason = $state('');
	let cancelMessage = $state<string | null>(null);
	async function cancelPayout(e: SubmitEvent) {
		e.preventDefault();
		const parsed = cancelPayoutSchema.safeParse({ reason });
		if (!parsed.success || !cancelOf) {
			cancelMessage = parsed.error?.issues[0]?.message ?? null;
			return;
		}
		busy = true;
		try {
			await organizations.call('POST', `/owner-payouts/${cancelOf}/cancel`, parsed.data);
			cancelOpen = false;
		} catch (error) {
			cancelMessage = messageOf(error);
		} finally {
			busy = false;
		}
	}

	const select = 'min-h-11 w-full rounded-lg border bg-background px-3 text-base';
</script>

{#snippet actions()}
	<section class="space-y-3 rounded-xl border bg-card p-4" data-testid="releve-actions">
		{#if !sync.online}<p class="text-sm text-muted-foreground">{t.onlineOnly}</p>{/if}
		{#if !issued && can(role, 'statement.issue')}
			<Button onclick={issue} disabled={!sync.online || busy} class="w-full" data-testid="emettre-releve">{t.issue}</Button>
			<Button variant="outline" onclick={recompute} disabled={!sync.online || busy} class="w-full">{t.recompute}</Button>
		{/if}
		{#if issued}
			{#if statement?.pdfAvailable}
				<Button variant="outline" onclick={pdf} disabled={!sync.online || busy} class="w-full"
					><Download class="size-5" aria-hidden="true" />{t.pdf}</Button
				>
			{:else}
				<p class="text-sm text-muted-foreground">{t.pdfPending}</p>
			{/if}
			{#if can(role, 'statement.share')}
				<Button variant="whatsapp" onclick={share} disabled={!sync.online || busy} class="w-full" data-testid="partager-releve"
					><MessageCircle class="size-5" aria-hidden="true" />{t.share}</Button
				>
				<Button variant="outline" onclick={copy} disabled={!sync.online || busy} class="w-full"
					><Link class="size-5" aria-hidden="true" />{t.copyLink}</Button
				>
				<Button variant="ghost" onclick={revoke} disabled={!sync.online || busy} class="w-full" data-testid="revoquer-liens"
					>{t.revoke}</Button
				>
			{/if}
			{#if can(role, 'statement.issue') && statement?.version === latestVersion}
				<Button variant="outline" onclick={rectify} disabled={!sync.online || busy} class="w-full">{t.rectify}</Button>
			{/if}
		{/if}
		{#if shared}<p class="text-sm break-all text-muted-foreground" data-testid="lien-releve">{shared.url}</p>{/if}
	</section>

	{#if issued}
		<section class="space-y-3 rounded-xl border bg-card p-4" data-testid="reversements">
			<h3 class="text-lg font-semibold">{t.payouts}</h3>
			<dl class="grid grid-cols-2 gap-1 text-base">
				<dt class="text-muted-foreground">{t.paidOut}</dt>
				<dd class="text-right tabular-nums">{formatFcfa(paidOut)}</dd>
				<dt class="text-muted-foreground">{t.remaining}</dt>
				<dd class="text-right font-semibold tabular-nums" data-testid="reste-a-reverser">{formatFcfa(remaining)}</dd>
			</dl>
			{#if !payoutRows.length}
				<p class="text-sm text-muted-foreground">{t.payoutsEmpty}</p>
			{:else}
				<ul class="divide-y">
					{#each payoutRows as p (p.id)}
						<li class="space-y-1 py-2">
							<p class="flex flex-wrap items-center justify-between gap-2">
								<span>{formatDate(p.paidOn)} · {t.methods[p.method] ?? p.method}</span>
								<span class="tabular-nums">{p.kind === 'reversal' ? '−' : ''}{formatFcfa(p.amount)}</span>
							</p>
							{#if p.reference}<p class="text-sm text-muted-foreground">{p.reference}</p>{/if}
							{#if p.kind === 'reversal'}<p class="text-sm text-muted-foreground">{t.payoutCancelled} : {p.reason}</p>{/if}
							{#if p.kind === 'payout' && reversed.has(p.id)}<Badge variant="danger">{t.payoutCancelled}</Badge>
							{:else if p.kind === 'payout' && can(role, 'payout.cancel')}
								<Button
									variant="ghost"
									onclick={() => ((cancelOf = p.id), (reason = ''), (cancelMessage = null), (cancelOpen = true))}
									disabled={!sync.online}>{t.cancelPayout}</Button
								>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
			{#if can(role, 'payout.record') && remaining > 0}
				<Button onclick={openPayout} disabled={!sync.online} class="w-full" data-testid="enregistrer-reversement">{t.recordPayout}</Button>
			{/if}
		</section>
	{/if}
{/snippet}

<PageHeader title={statement ? `${statement.ownerName} · ${monthLabel(statement.month)}` : t.title}>
	{#snippet actions()}
		<Button variant="ghost" href={resolve('/app/releves')}><ArrowLeft class="size-5" aria-hidden="true" />{t.back}</Button>
	{/snippet}
</PageHeader>

<main class="page pt-3 pb-10" data-testid="releve">
	<FeatureGate key="collections.owner_statements">
		<div class="space-y-3">
			<FormAlert {message} />
			<FormAlert message={info} tone="info" />
		</div>
		{#if loaded && !statement && (remoteState === 'failed' || !sync.online)}
			<FormAlert message={t.notFound} />
		{:else if statement && doc}
			<div class={device.isPhone ? 'mt-3 space-y-4' : 'mt-3 grid grid-cols-[1fr_20rem] items-start gap-6'}>
				<div class="min-w-0 space-y-2">
					<div class="flex flex-wrap items-center gap-2">
						<Badge variant={issued ? 'success' : 'warning'}>{issued ? t.status.issued : t.status.draft}</Badge>
						{#if statement.issuedOn}<span class="text-sm text-muted-foreground"
								>{fr.statementPublic.issuedOn(formatDate(statement.issuedOn))}</span
							>{/if}
					</div>
					<StatementDocumentView document={doc} draftNote={t.draftNote} />
				</div>
				<div class="space-y-4">{@render actions()}</div>
			</div>
		{/if}
	</FeatureGate>
</main>

<Sheet bind:open={payoutOpen} labelledby="reversement-titre" side="right">
	<form class="space-y-4" onsubmit={savePayout} data-testid="formulaire-reversement">
		<h2 id="reversement-titre" class="pr-10 text-xl font-semibold">{t.recordPayout}</h2>
		<FormAlert message={payoutMessage} />
		<div class="space-y-1">
			<label for="reversement-montant" class="text-base font-medium">{t.payoutAmount}</label>
			<Input id="reversement-montant" inputmode="numeric" bind:value={amount} class="tabular-nums" />
		</div>
		<div class="space-y-1">
			<label for="reversement-date" class="text-base font-medium">{t.payoutDate}</label>
			<Input id="reversement-date" type="date" bind:value={paidOn} max={today} />
		</div>
		<div class="space-y-1">
			<label for="reversement-moyen" class="text-base font-medium">{t.payoutMethod}</label>
			<select id="reversement-moyen" class={select} bind:value={method}>
				{#each PAYOUT_METHODS as m (m)}<option value={m}>{t.methods[m]}</option>{/each}
			</select>
		</div>
		<div class="space-y-1">
			<label for="reversement-reference" class="text-base font-medium">{t.payoutReference}</label>
			<Input id="reversement-reference" bind:value={reference} maxlength={60} />
		</div>
		<Button type="submit" class="w-full" disabled={busy}>{t.recordPayout}</Button>
	</form>
</Sheet>

<Sheet bind:open={cancelOpen} labelledby="annuler-reversement-titre">
	<form class="space-y-4" onsubmit={cancelPayout}>
		<h2 id="annuler-reversement-titre" class="pr-10 text-xl font-semibold">{t.cancelPayout}</h2>
		<FormAlert message={cancelMessage} />
		<div class="space-y-1">
			<label for="reversement-motif" class="text-base font-medium">{t.cancelPayoutReason}</label>
			<Input id="reversement-motif" bind:value={reason} maxlength={500} />
		</div>
		<Button type="submit" variant="destructive" class="w-full" disabled={busy || !sync.online}>{t.cancelPayout}</Button>
	</form>
</Sheet>
