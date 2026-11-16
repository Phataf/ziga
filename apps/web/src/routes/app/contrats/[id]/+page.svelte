<script lang="ts">
	/**
	 * Fiche du contrat (lot 08 bis, docs/UX.md §10). Lue sur l'appareil : statut, versions (empreintes, champs vides),
	 * signataires, légalisation, chronologie. En ligne : aperçu PDF (lien signé de 5 minutes, journalisé), actions selon
	 * le statut (soumettre, revenir au brouillon, régénérer, figer, modifier), légalisation et enregistrement ; l'avis
	 * « à régénérer » du serveur, qui compare les conditions elles-mêmes, remplace celui de l'appareil. Le dépôt du scan
	 * se prépare hors ligne (file de l'appareil).
	 *
	 * Téléphone : aperçu en plein écran (Échap ou « Fermer » pour revenir), actions en bas d'écran. Ordinateur : aperçu à
	 * gauche, actions et suivi à droite.
	 */
	import { onMount } from 'svelte';
	import { CheckCheck, Download, Eye, FilePenLine, RefreshCw, Send, Signature, Undo2, X } from '@lucide/svelte';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { contractField } from '@ziga/shared/contract-fields';
	import { formatDate, toIsoDate } from '@ziga/shared/dates';
	import { cancelAmendmentSchema, type ContractDetailView, type ContractVersionView } from '@ziga/shared/contracts';
	import { can } from '@ziga/shared/permissions';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import ContractTracking from '#lib/components/contracts/ContractTracking.svelte';
	import ScanDeposit from '#lib/components/contracts/ScanDeposit.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { scanQueue } from '#lib/contracts/scan-queue.svelte.ts';
	import { alertTone, contractTone } from '#lib/contracts/tones.ts';
	import { contractTimeline, signerDates, toAmendment, toContract, toContractVersion } from '#lib/contracts/views.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';

	type Row = Record<string, unknown>;
	const t = fr.contracts;
	const today = toIsoDate();
	const role = $derived(organizations.active?.role);
	const allowed = $derived(can(role, 'contract.read'));
	const canCreate = $derived(can(role, 'contract.create'));
	const canFreeze = $derived(can(role, 'contract.freeze'));
	const canSign = $derived(can(role, 'contract.upload_signed'));
	const id = $derived(page.params.id ?? '');

	let row = $state<Row | null>(null);
	let versionRows = $state<Row[]>([]);
	let leaseRow = $state<Row | null>(null);
	let amendmentRow = $state<Row | null>(null);
	let members = $state<Record<string, string>>({});
	let unitLabel = $state('');
	let tenantName = $state('');
	let loaded = $state(false);
	/** Avis du serveur (« à régénérer » exact), lu en ligne. */
	let server = $state<ContractDetailView | null>(null);
	let previewUrl = $state<string | null>(null);
	let previewFor = $state<number | null>(null);
	let fullscreen = $state(false);
	let panel = $state<'scan' | 'cancel' | null>(null);
	let reason = $state('');
	let message = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let busy = $state(false);

	onMount(() => {
		if (!allowed) return;
		void scanQueue.start();
		const org = organizations.activeId;
		const onError = (error: Error) => (message = messageOf(error));
		const stops = [
			sync.watch<Row>(
				LOCAL_QUERIES.contract,
				[org, id],
				(rows) => {
					row = rows[0] ?? null;
					loaded = true;
				},
				onError
			),
			sync.watch<Row>(LOCAL_QUERIES.contractVersions, [org, id], (rows) => (versionRows = rows), onError),
			sync.watch<Row>(
				LOCAL_QUERIES.members,
				[org],
				(rows) => (members = Object.fromEntries(rows.map((r) => [String(r.user_id), String(r.display_name ?? '')]))),
				onError
			)
		];
		return () => stops.forEach((stop) => stop());
	});

	// Bail, unité, locataire et avenant, dès que le contrat est lu.
	$effect(() => {
		const org = organizations.activeId;
		const leaseId = row ? String(row.lease_id) : null;
		const amendmentId = row?.amendment_id ? String(row.amendment_id) : null;
		if (!leaseId) return;
		const stops = [
			sync.watch<Row>(LOCAL_QUERIES.contractLeases, [org], (rows) => {
				const l = rows.find((r) => String(r.id) === leaseId) ?? null;
				leaseRow = l;
				unitLabel = String(l?.unit_label ?? '');
				tenantName = String(l?.tenant_name ?? '');
			})
		];
		if (amendmentId) stops.push(sync.watch<Row>(LOCAL_QUERIES.amendment, [org, amendmentId], (rows) => (amendmentRow = rows[0] ?? null)));
		return () => stops.forEach((stop) => stop());
	});

	const local = $derived(
		row
			? toContract(row, {
					leaseVersion: leaseRow ? Number(leaseRow.version ?? 1) : null,
					frozenLeaseVersion: row.frozen_lease_version == null ? null : Number(row.frozen_lease_version),
					recordedByName: row.signature_recorded_by ? (members[String(row.signature_recorded_by)] ?? null) : null,
					today
				})
			: null
	);
	/** L'avis du serveur, s'il est à jour de la même version, l'emporte sur celui de l'appareil. */
	const contract = $derived(
		local && server && server.id === local.id && server.updatedAt === local.updatedAt
			? { ...local, outdated: server.outdated, alerts: server.alerts }
			: local
	);
	const versions = $derived<ContractVersionView[]>(versionRows.map(toContractVersion));
	const current = $derived(versions.find((v) => v.number === contract?.currentVersion) ?? versions[0] ?? null);
	const amendment = $derived(amendmentRow ? toAmendment(amendmentRow, id) : null);
	const timeline = $derived(contract ? contractTimeline(contract, versions, amendment) : []);
	const queued = $derived(scanQueue.items.filter((s) => s.contractId === id));
	const pending = $derived(contract?.generationStatus === 'pending');
	const title = $derived(amendment ? t.amendmentTitle(amendment.number) : t.leaseContract);

	// Avis du serveur et aperçu, en ligne, à chaque changement du contrat.
	$effect(() => {
		const c = local;
		if (!c || !sync.online) return;
		organizations
			.call<ContractDetailView>('GET', `/contracts/${c.id}`)
			.then((v) => (server = v))
			.catch(() => undefined);
	});

	async function loadPreview(number: number) {
		if (previewFor === number && previewUrl) return;
		try {
			const { url } = await organizations.call<{ url: string }>('GET', `/contracts/${id}/versions/${number}/download?format=pdf`);
			previewUrl = url;
			previewFor = number;
		} catch (error) {
			message = messageOf(error);
		}
	}

	$effect(() => {
		if (device.isDesktop && sync.online && current && contract?.origin === 'generated' && !pending) void loadPreview(current.number);
	});

	async function download(number: number, format: 'pdf' | 'docx') {
		message = null;
		try {
			const { url } = await organizations.call<{ url: string }>('GET', `/contracts/${id}/versions/${number}/download?format=${format}`);
			window.open(url, '_blank', 'noopener');
		} catch (error) {
			message = messageOf(error);
		}
	}

	async function act(path: string, body?: unknown) {
		message = null;
		notice = null;
		busy = true;
		try {
			server = await organizations.call<ContractDetailView>('POST', `/contracts/${id}/${path}`, body);
			notice = t.requested;
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}

	async function cancelAmendment(event: SubmitEvent) {
		event.preventDefault();
		const parsed = cancelAmendmentSchema.safeParse({ reason });
		if (!parsed.success || !amendment) return void (message = parsed.error?.issues[0]?.message ?? null);
		busy = true;
		try {
			await organizations.call('POST', `/amendments/${amendment.id}/cancel`, parsed.data);
			panel = null;
			notice = t.requested;
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}

	function openFullscreen() {
		if (!current) return;
		fullscreen = true;
		void loadPreview(current.number);
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;
		if (fullscreen) fullscreen = false;
		else if (panel) panel = null;
	}

	const fieldLabel = (tag: string) => contractField(tag)?.label ?? tag;
	function eventLabel(e: (typeof timeline)[number]): string {
		if (e.kind === 'version') return t.events.version(e.number);
		if (e.kind === 'frozen') return t.events.frozen(e.number);
		return t.events[e.kind];
	}
</script>

<svelte:window onkeydown={onKeydown} />

<PageHeader {title} subtitle={unitLabel ? `${unitLabel} · ${tenantName}` : undefined} back="app/contrats" backLabel={t.back} />

{#snippet actions()}
	{#if contract && sync.online}
		{#if contract.status === 'draft' && canCreate}
			<Button
				onclick={() => act('submit', { expectedVersion: contract.currentVersion })}
				disabled={busy || pending || !current}
				data-testid="soumettre"><Send aria-hidden="true" />{t.submit}</Button
			>
		{/if}
		{#if contract.status === 'in_review' && canFreeze}
			<Button
				onclick={() => act('freeze', { expectedVersion: contract.currentVersion })}
				disabled={busy || pending || !current || (current?.blankFields.length ?? 0) > 0}
				data-testid="figer"><CheckCheck aria-hidden="true" />{t.freeze}</Button
			>
		{/if}
		{#if contract.status === 'in_review' && canCreate}
			<Button variant="outline" onclick={() => act('return-to-draft')} disabled={busy} data-testid="revenir-brouillon"
				><Undo2 aria-hidden="true" />{t.returnToDraft}</Button
			>
		{/if}
		{#if (contract.status === 'draft' || contract.status === 'in_review') && canCreate && contract.origin === 'generated'}
			<Button
				variant="outline"
				onclick={() => act('versions', { expectedVersion: Math.max(contract.currentVersion, 1) })}
				disabled={busy || pending}
				data-testid="regenerer"><RefreshCw aria-hidden="true" />{t.regenerate}</Button
			>
		{/if}
		{#if contract.status === 'ready_to_sign' && canCreate}
			<Button
				variant="outline"
				onclick={() => act('versions', { expectedVersion: contract.currentVersion })}
				disabled={busy || pending}
				data-testid="modifier"><FilePenLine aria-hidden="true" />{t.modify}</Button
			>
		{/if}
	{/if}
	{#if contract?.status === 'ready_to_sign' && canSign && !queued.length}
		<Button onclick={() => (panel = panel === 'scan' ? null : 'scan')} data-testid="deposer-scan"
			><Signature aria-hidden="true" />{t.depositScan}</Button
		>
	{/if}
{/snippet}

{#snippet preview()}
	{#if contract?.origin === 'generated' && current}
		{#if !sync.online}
			<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground">{t.online}</p>
		{:else if previewUrl && previewFor === current.number}
			<iframe title={t.preview} src={previewUrl} class="h-full min-h-[70vh] w-full rounded-xl border bg-white" data-testid="apercu-pdf"
			></iframe>
			<Button variant="link" class="self-start px-0" onclick={() => window.open(previewUrl!, '_blank', 'noopener')}
				>{t.previewNewTab}</Button
			>
		{/if}
	{/if}
{/snippet}

<main class="page pt-3 pb-28 md:pb-10" data-testid="fiche-contrat" data-statut={contract?.status}>
	{#if !allowed}
		<FormAlert message={t.noAccess} />
	{:else if loaded && !contract}
		<FormAlert message={t.notFound} />
	{:else if contract}
		<div class={device.isDesktop ? 'grid grid-cols-[minmax(0,1fr)_minmax(0,26rem)] gap-6' : 'space-y-4'}>
			{#if device.isDesktop}
				<div class="space-y-2" data-testid="colonne-apercu">{@render preview()}</div>
			{/if}
			<div class="min-w-0 space-y-4">
				<FormAlert {message} />
				{#if notice}<FormAlert message={notice} tone="info" />{/if}
				{#if contract.defaultTemplateNotice}<FormAlert message={t.defaultBanner} tone="info" />{/if}

				<section class="space-y-3 rounded-2xl border bg-card p-4 md:p-6" data-testid="etat-contrat">
					<div class="flex flex-wrap items-center gap-2">
						<Badge variant={contractTone(contract.status)} data-testid="statut-contrat">{t.status[contract.status]}</Badge>
						{#if pending}<Badge variant="info" data-testid="generation-en-cours">{t.generating}</Badge>{/if}
						{#each contract.alerts as a (a)}<Badge variant={alertTone(a)} data-testid="alerte">{t.alerts[a]}</Badge>{/each}
					</div>
					{#if contract.generationStatus === 'failed'}<FormAlert
							message={`${t.generationFailed} : ${contract.generationError ?? ''}`}
						/>{/if}
					{#if leaseRow}
						<a class="block text-base underline" href={resolve('/app/baux/[id]', { id: contract.leaseId })}
							>{fr.leases.leaseOf(unitLabel)}</a
						>
					{/if}
					{#if contract.signingPlace && contract.signingDate}
						<p class="text-base">{contract.signingPlace}, {formatDate(contract.signingDate)} · {t.copies} : {contract.copies}</p>
					{/if}
					{#if current}
						<p class="text-base">
							{contract.frozenVersion === current.number ? t.frozenVersion(current.number) : t.version(current.number)}
							{#if current.pageCount}· {t.pages(current.pageCount)}{/if}
						</p>
						{#if current.blankFields.length}
							<div class="space-y-1 rounded-xl border border-warning p-3" data-testid="champs-vides">
								<p class="font-medium">{t.blanks}</p>
								<ul class="list-inside list-disc text-base">
									{#each current.blankFields as f (f)}<li>{fieldLabel(f)}</li>{/each}
								</ul>
								<p class="text-sm text-muted-foreground">{t.blanksHint}</p>
							</div>
						{:else}
							<p class="text-sm text-muted-foreground" data-testid="aucun-champ-vide">{t.noBlanks}</p>
						{/if}
						{#each current.warnings as w (w)}<FormAlert message={t.warnings[w] ?? w} tone="info" />{/each}
						{#if !device.isDesktop && sync.online && !pending}
							<Button variant="outline" onclick={openFullscreen} data-testid="ouvrir-apercu"
								><Eye aria-hidden="true" />{t.previewOpen}</Button
							>
						{/if}
					{/if}
					{#if !sync.online}<FormAlert message={t.onlineHint} tone="info" />{/if}
					{#if contract.status === 'in_review'}<p class="text-sm text-muted-foreground">{t.freezeHint}</p>{/if}
					{#if contract.status === 'ready_to_sign'}<p class="text-sm text-muted-foreground">{t.modifyHint}</p>{/if}
					{#if device.isDesktop}<div class="flex flex-wrap gap-2">{@render actions()}</div>{/if}
				</section>

				{#each queued as q (q.id)}
					<div class="space-y-2 rounded-xl border p-3" data-testid="scan-en-file">
						{#if q.error}
							<FormAlert message={`${t.scan.refused} : ${q.error}`} />
							<Button variant="outline" onclick={() => scanQueue.remove(q.id)}>{t.scan.discard}</Button>
						{:else}
							<FormAlert message={scanQueue.sending === q.id ? t.scan.sending : t.scan.queued} tone="info" />
						{/if}
					</div>
				{/each}
				{#if panel === 'scan' && contract.status === 'ready_to_sign'}
					<ScanDeposit {contract} done={() => (panel = null)} />
				{/if}

				{#if contract.status === 'signed' || contract.expectedSigners}
					<section class="space-y-2 rounded-2xl border bg-card p-4 md:p-6" data-testid="signataires">
						<h2 class="text-lg font-semibold">{t.signedTitle}</h2>
						{#if contract.signatureLabel}<p class="text-base" data-testid="libelle-signature">{contract.signatureLabel}</p>{/if}
						<ul class="space-y-1 text-base">
							{#each signerDates(contract) as s (s.party)}
								<li>{s.date ? t.signedOn(t.parties[s.party]!, formatDate(s.date)) : t.parties[s.party]}</li>
							{/each}
						</ul>
					</section>
				{/if}

				{#if contract.status === 'signed'}<ContractTracking {contract} canEdit={canSign} />{/if}

				{#if amendment && amendment.status === 'draft' && contract.status !== 'signed' && canCreate && sync.online}
					<section class="space-y-2 rounded-2xl border bg-card p-4 md:p-6">
						<Button variant="outline" onclick={() => (panel = panel === 'cancel' ? null : 'cancel')}>{t.cancelAmendment}</Button>
						{#if panel === 'cancel'}
							<form class="space-y-3" onsubmit={cancelAmendment} novalidate>
								<label for="motif-avenant" class="block font-medium">{t.cancelReason}</label>
								<Input id="motif-avenant" bind:value={reason} />
								<Button type="submit" variant="destructive" disabled={busy}>{t.cancelSubmit}</Button>
							</form>
						{/if}
					</section>
				{/if}

				{#if versions.length}
					<section class="space-y-2 rounded-2xl border bg-card p-4 md:p-6" data-testid="versions">
						<h2 class="text-lg font-semibold">{t.versions}</h2>
						<ul class="divide-y rounded-xl border">
							{#each versions as v (v.id)}
								<li class="space-y-1 p-3" data-testid="version">
									<span class="flex flex-wrap items-center justify-between gap-2">
										<span class="font-medium"
											>{contract.frozenVersion === v.number ? t.frozenVersion(v.number) : t.version(v.number)} · {formatDate(
												v.createdAt
											)}</span
										>
										{#if sync.online}
											<span class="flex gap-1">
												<Button variant="ghost" onclick={() => download(v.number, 'pdf')}
													><Download aria-hidden="true" />{t.downloadPdf}</Button
												>
												<Button variant="ghost" onclick={() => download(v.number, 'docx')}
													><Download aria-hidden="true" />{t.downloadDocx}</Button
												>
											</span>
										{/if}
									</span>
									<span class="block text-sm break-all text-muted-foreground">{t.fingerprint} : {v.pdfSha256}</span>
								</li>
							{/each}
						</ul>
					</section>
				{/if}

				<section class="space-y-2 rounded-2xl border bg-card p-4 md:p-6" data-testid="chronologie-contrat">
					<h2 class="text-lg font-semibold">{t.timeline}</h2>
					<ol class="space-y-1">
						{#each timeline as e, i (i)}
							<li class="flex flex-wrap gap-2 text-base">
								<span class="text-muted-foreground tabular-nums">{formatDate(e.at)}</span><span>{eventLabel(e)}</span>
							</li>
						{/each}
					</ol>
				</section>
			</div>
		</div>

		{#if !device.isDesktop}
			<div
				class="fixed right-0 z-30 border-t bg-background/95 p-3 backdrop-blur {device.isPhone
					? 'bottom-[calc(4rem+env(safe-area-inset-bottom))] left-0'
					: 'bottom-0 left-28'}"
				data-testid="barre-actions"
			>
				<div class="flex flex-wrap gap-2">{@render actions()}</div>
			</div>
		{/if}

		{#if fullscreen}
			<div
				class="fixed inset-0 z-50 flex flex-col bg-background"
				role="dialog"
				aria-modal="true"
				aria-label={t.preview}
				data-testid="apercu-plein-ecran"
			>
				<div class="flex items-center justify-between gap-2 border-b p-2">
					<span class="px-2 font-semibold">{t.preview}</span>
					<Button variant="outline" onclick={() => (fullscreen = false)}><X aria-hidden="true" />{t.previewClose}</Button>
				</div>
				<div class="flex min-h-0 flex-1 flex-col gap-2 p-2">{@render preview()}</div>
			</div>
		{/if}
	{/if}
</main>
