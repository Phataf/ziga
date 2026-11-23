<script lang="ts">
	/**
	 * Un import (lot 11) : suivi de l'analyse et de l'exécution (tâches de fond, relues par l'écran), prévisualisation
	 * exacte (lignes en erreur, écartées en cascade, avertissements ; chaque message dit la ligne, la colonne et quoi
	 * corriger), choix à faire (cautions sans montant reçu, quartiers, fiches déjà enregistrées), lancement, compte rendu
	 * par onglet, rapport téléchargeable, annulation dans les 24 heures. En ligne seulement.
	 */
	import { onMount } from 'svelte';
	import { ArrowRight, Download, Play, RefreshCw, Undo2 } from '@lucide/svelte';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { formatDate } from '@ziga/shared/dates';
	import { IMPORT_SHEET_KEYS, IMPORT_SHEET_NAMES } from '@ziga/shared/import-template';
	import type { ImportChoices, ImportJobView } from '@ziga/shared/imports';
	import { can } from '@ziga/shared/permissions';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import FeatureGate from '#lib/components/FeatureGate.svelte';
	import ImportStatusBadge from '#lib/components/imports/ImportStatusBadge.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { device } from '#lib/device.svelte.ts';
	import { importBusy, issuesBySheet } from '#lib/imports/views.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { GEOGRAPHY_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';

	type Row = Record<string, unknown>;
	const t = fr.imports;
	const id = $derived(page.params.id!);
	const role = $derived(organizations.active?.role);
	const allowed = $derived(can(role, 'import.run'));
	const field = 'min-h-12 w-full min-w-0 rounded-lg border-2 border-input bg-card px-3 text-base';
	const POLL_MS = 1_500;

	let job = $state<ImportJobView | null>(null);
	let message = $state<string | null>(null);
	let acting = $state(false);
	/** Choix en cours de saisie, appliqués par une nouvelle analyse. */
	let draft = $state<ImportChoices>({ places: {}, matches: {} });
	let dirty = $state(false);
	let cancelOpen = $state(false);
	let reason = $state('');
	/** Annulation demandée : la tâche de fond la fait ; l'écran relit jusqu'à « annulé ». */
	let awaitingCancel = $state(false);
	let cancelRequestedAt = 0;
	/** Au-delà, l'annulation n'a pas abouti (refus imprévu de la tâche de fond) : l'écran cesse d'attendre et le dit. */
	const CANCEL_WAIT_MS = 120_000;
	let communes = $state<Row[]>([]);
	let neighborhoods = $state<Row[]>([]);
	let timer: ReturnType<typeof setTimeout> | undefined;

	onMount(() => {
		const stops = [
			sync.watch<Row>(GEOGRAPHY_QUERIES.communes, [], (r) => (communes = r)),
			sync.watch<Row>(GEOGRAPHY_QUERIES.neighborhoods, [], (r) => (neighborhoods = r))
		];
		if (allowed) void load();
		return () => {
			clearTimeout(timer);
			stops.forEach((s) => s());
		};
	});

	function adopt(view: ImportJobView) {
		job = view;
		if (!dirty)
			draft = { places: { ...view.choices.places }, matches: { ...view.choices.matches }, depositReceived: view.choices.depositReceived };
		if (awaitingCancel && (view.status === 'cancelled' || view.error)) awaitingCancel = false;
	}

	async function load() {
		clearTimeout(timer);
		try {
			adopt(await organizations.call<ImportJobView>('GET', `/imports/${id}`));
		} catch (error) {
			message = messageOf(error);
		}
		if (awaitingCancel && Date.now() - cancelRequestedAt > CANCEL_WAIT_MS) {
			awaitingCancel = false;
			message = t.cancel.notDone;
		}
		if (job && (importBusy(job.status) || awaitingCancel)) timer = setTimeout(() => void load(), POLL_MS);
	}

	async function act(fn: () => Promise<ImportJobView | void>) {
		message = null;
		acting = true;
		try {
			const view = await fn();
			if (view) adopt(view);
		} catch (error) {
			message = messageOf(error);
		} finally {
			acting = false;
		}
		await load();
	}

	function applyChoices() {
		return act(async () => {
			const view = await organizations.call<ImportJobView>('POST', `/imports/${id}/analyze`, { choices: draft });
			dirty = false;
			return view;
		});
	}

	const run = () => act(() => organizations.call<ImportJobView>('POST', `/imports/${id}/execute`));

	async function report() {
		message = null;
		try {
			const { url } = await organizations.call<{ url: string }>('GET', `/imports/${id}/report`);
			const a = document.createElement('a');
			a.href = url;
			a.rel = 'noopener';
			document.body.append(a);
			a.click();
			a.remove();
		} catch (error) {
			message = messageOf(error);
		}
	}

	function cancel(event: SubmitEvent) {
		event.preventDefault();
		return act(async () => {
			const view = await organizations.call<ImportJobView>('POST', `/imports/${id}/cancel`, { reason });
			awaitingCancel = true;
			cancelRequestedAt = Date.now();
			cancelOpen = false;
			return view;
		});
	}

	function choose(kind: 'places' | 'matches', key: string, value: string) {
		draft = { ...draft, [kind]: { ...draft[kind], [key]: value === '' ? undefined : value === 'none' ? null : value } };
		dirty = true;
	}

	function chooseDeposit(value: 'full' | 'to_complete') {
		draft = { ...draft, depositReceived: value };
		dirty = true;
	}

	const preview = $derived(job?.preview ?? null);
	const groups = $derived(preview ? issuesBySheet(preview.issues) : []);
	const places = $derived(preview ? preview.places.filter((p) => p.status !== 'matched') : []);
	const communeName = $derived(new Map(communes.map((c) => [String(c.id), String(c.name ?? '')])));
	const neighborhoodLabel = (n: Row) => `${String(n.name ?? '')} (${communeName.get(String(n.commune_id)) ?? ''})`;
	const placeValue = (key: string) => {
		const v = draft.places[key];
		return v === null ? 'none' : (v ?? '');
	};
	const reportSheets = $derived(
		job?.report ? IMPORT_SHEET_KEYS.flatMap((k) => (job!.report!.sheets[k] ? [{ key: k, ...job!.report!.sheets[k]! }] : [])) : []
	);
	const severityTone = { error: 'danger', skipped: 'warning', warning: 'info' } as const;
	const canRun = $derived(
		!!job && job.status === 'analyzed' && !!preview && preview.blockers.length === 0 && !dirty && !acting && sync.online
	);
</script>

<PageHeader title={job?.fileName ?? t.title} back="app/import" backLabel={t.back} />

<main class="page space-y-4 pt-3 pb-10" data-testid="import-detail">
	<FeatureGate key="imports.excel">
		{#if !allowed}
			<FormAlert message={t.noAccess} />
		{:else if job}
			<section class="space-y-2 rounded-2xl border bg-card p-4 md:p-6">
				<p class="flex flex-wrap items-center gap-2" data-testid="statut-import" data-statut={job.status}>
					<ImportStatusBadge status={job.status} />
					<span class="text-base text-muted-foreground">{t.switchOnLabel(formatDate(job.switchOn))}</span>
				</p>
				{#if job.status === 'analyzing' || job.status === 'uploaded'}<FormAlert message={t.working} tone="info" />{/if}
				{#if job.status === 'running'}<FormAlert message={t.running} tone="info" />{/if}
				{#if job.error}<FormAlert message={job.error} />{/if}
				{#if job.status === 'cancelled' && job.cancelledAt}
					<p class="text-base">{t.cancel.cancelledOn(formatDate(job.cancelledAt), job.cancellationReason ?? '')}</p>
				{/if}
				{#if job.fileDeletedAt}<p class="text-sm text-muted-foreground">{t.fileDeleted}</p>{/if}
			</section>
			{#if !sync.online}<FormAlert message={t.offline} tone="info" />{/if}
			<FormAlert {message} />

			{#if preview && job.status === 'analyzed'}
				<section class="min-w-0 space-y-3 rounded-2xl border bg-card p-4 md:p-6" data-testid="apercu">
					<h2 class="text-lg font-semibold">{t.preview.title}</h2>
					<p class="text-base text-muted-foreground">{t.preview.help}</p>
					<p class="text-base font-medium">{t.preview.summary(preview.summary.newUnits, preview.summary.leases)}</p>
					{#if preview.summary.leasesWithOpeningBalance > 0}
						<p class="rounded-lg bg-warning-soft p-3 text-base text-warning-foreground" data-testid="avertissement-soldes">
							{t.preview.openingBalances(preview.summary.leasesWithOpeningBalance)}
						</p>
					{/if}
					{#if preview.summary.depositsAboveCap > 0}<FormAlert
							message={t.preview.depositsAboveCap(preview.summary.depositsAboveCap)}
							tone="info"
						/>{/if}
					{#if preview.unknownSheets.length}<FormAlert
							message={t.preview.unknownSheets(preview.unknownSheets.join(', '))}
							tone="info"
						/>{/if}
					{#if device.isDesktop}
						<div class="relative overflow-x-auto rounded-xl border">
							<table class="w-full text-left text-base">
								<thead class="border-b text-muted-foreground">
									<tr>
										<th class="px-4 py-2 font-medium">{t.preview.sheet}</th>
										<th class="px-4 py-2 text-right font-medium">{t.preview.rows}</th>
										<th class="px-4 py-2 text-right font-medium">{t.preview.planned}</th>
										<th class="px-4 py-2 text-right font-medium">{t.preview.errors}</th>
										<th class="px-4 py-2 text-right font-medium">{t.preview.skipped}</th>
										<th class="px-4 py-2 text-right font-medium">{t.preview.warnings}</th>
									</tr>
								</thead>
								<tbody class="divide-y">
									{#each preview.sheets as s (s.key)}
										<tr data-testid="onglet-apercu">
											<td class="px-4 py-2">{s.name}</td>
											<td class="px-4 py-2 text-right tabular-nums">{s.rows}</td>
											<td class="px-4 py-2 text-right tabular-nums">{s.planned}</td>
											<td class="px-4 py-2 text-right tabular-nums">{s.errors}</td>
											<td class="px-4 py-2 text-right tabular-nums">{s.skipped}</td>
											<td class="px-4 py-2 text-right tabular-nums">{s.warnings}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					{:else}
						<ul class="grid gap-2 sm:grid-cols-2">
							{#each preview.sheets as s (s.key)}
								<li class="space-y-1 rounded-xl border p-3" data-testid="onglet-apercu">
									<p class="font-semibold">{s.name}</p>
									<p class="text-sm text-muted-foreground">
										{t.preview.rows} : {s.rows} · {t.preview.planned} : {s.planned}
									</p>
									<p class="flex flex-wrap gap-1">
										{#if s.errors}<Badge variant="danger">{t.preview.errors} : {s.errors}</Badge>{/if}
										{#if s.skipped}<Badge variant="warning">{t.preview.skipped} : {s.skipped}</Badge>{/if}
										{#if s.warnings}<Badge variant="info">{t.preview.warnings} : {s.warnings}</Badge>{/if}
									</p>
								</li>
							{/each}
						</ul>
					{/if}
				</section>

				{#if preview.pending.depositsWithoutReceived.length || places.length || preview.matches.length}
					<section class="min-w-0 space-y-4 rounded-2xl border bg-card p-4 md:p-6" data-testid="choix">
						<h2 class="text-lg font-semibold">{t.choices.title}</h2>
						{#if preview.pending.depositsWithoutReceived.length}
							<fieldset class="min-w-0 space-y-2" data-testid="choix-cautions">
								<legend class="font-medium">{t.choices.deposits(preview.pending.depositsWithoutReceived.length)}</legend>
								<p class="text-sm text-muted-foreground">{t.choices.depositsHelp}</p>
								<label class="flex min-h-11 items-center gap-3 text-base">
									<input
										type="radio"
										name="caution"
										class="size-5 shrink-0"
										checked={draft.depositReceived === 'full'}
										onchange={() => chooseDeposit('full')}
										data-testid="caution-full"
									/>{t.choices.full}
								</label>
								<label class="flex min-h-11 items-center gap-3 text-base">
									<input
										type="radio"
										name="caution"
										class="size-5 shrink-0"
										checked={draft.depositReceived === 'to_complete'}
										onchange={() => chooseDeposit('to_complete')}
										data-testid="caution-to_complete"
									/>{t.choices.toComplete}
								</label>
							</fieldset>
						{/if}
						{#if places.length}
							<div class="space-y-2">
								<h3 class="font-medium">{t.choices.places}</h3>
								<p class="text-sm text-muted-foreground">{t.choices.placesHelp}</p>
								<ul class="space-y-2">
									{#each places as p (p.key)}
										{@const suggested = new Set(p.suggestions.map((s) => s.id))}
										<li
											class="grid min-w-0 gap-2 rounded-xl border p-3 md:grid-cols-2 md:items-center"
											data-testid="lieu"
											data-statut={p.status}
										>
											<label for="lieu-{p.key}" class="min-w-0 space-y-0.5">
												<span class="block font-medium break-words">« {p.neighborhood} »{p.commune ? ` (${p.commune})` : ''}</span>
												<span class="block text-sm text-muted-foreground">{t.choices.placeRows(p.rows.length)}</span>
											</label>
											<select
												id="lieu-{p.key}"
												class={field}
												value={placeValue(p.key)}
												onchange={(e) => choose('places', p.key, e.currentTarget.value)}
												data-testid="lieu-choix"
											>
												<option value="">{t.choices.placeUnresolved}</option>
												{#if p.suggestions.length}
													<optgroup label={t.choices.suggestions}>
														{#each p.suggestions as s (s.id)}<option value={s.id}>{s.name} ({s.communeName})</option>{/each}
													</optgroup>
												{/if}
												<optgroup label={t.choices.allNeighborhoods}>
													{#each neighborhoods.filter((n) => !suggested.has(String(n.id))) as n (n.id)}
														<option value={String(n.id)}>{neighborhoodLabel(n)}</option>
													{/each}
												</optgroup>
												<option value="none">{t.choices.placeNone}</option>
											</select>
										</li>
									{/each}
								</ul>
							</div>
						{/if}
						{#if preview.matches.length}
							<div class="space-y-2">
								<h3 class="font-medium">{t.choices.matches}</h3>
								<p class="text-sm text-muted-foreground">{t.choices.matchesHelp}</p>
								<ul class="space-y-2">
									{#each preview.matches as m (m.key)}
										<li class="grid min-w-0 gap-2 rounded-xl border p-3 md:grid-cols-2 md:items-center" data-testid="rapprochement">
											<label for="rapprochement-{m.key}" class="font-medium">{IMPORT_SHEET_NAMES[m.sheet]}, ligne {m.row}</label>
											<select
												id="rapprochement-{m.key}"
												class={field}
												value={draft.matches[m.key] === null ? 'none' : m.existingId}
												onchange={(e) => choose('matches', m.key, e.currentTarget.value)}
											>
												<option value={m.existingId}>{t.choices.useExisting(m.existingName)}</option>
												<option value="none">{t.choices.createNew}</option>
											</select>
										</li>
									{/each}
								</ul>
							</div>
						{/if}
						<Button variant="outline" onclick={applyChoices} disabled={!dirty || acting || !sync.online} data-testid="appliquer-choix"
							><RefreshCw aria-hidden="true" />{t.choices.apply}</Button
						>
					</section>
				{/if}

				<section class="min-w-0 space-y-3 rounded-2xl border bg-card p-4 md:p-6" data-testid="lignes">
					{#if !groups.length}<p class="text-base text-muted-foreground">{t.preview.noIssue}</p>{/if}
					{#each groups as g (g.sheet)}
						<details class="min-w-0 rounded-xl border" open={g.counts.error > 0 || g.counts.skipped > 0}>
							<summary class="flex min-h-11 cursor-pointer flex-wrap items-center gap-2 px-3 py-2 font-semibold">
								{IMPORT_SHEET_NAMES[g.sheet]}
								{#if g.counts.error}<Badge variant="danger">{t.preview.errors} : {g.counts.error}</Badge>{/if}
								{#if g.counts.skipped}<Badge variant="warning">{t.preview.skipped} : {g.counts.skipped}</Badge>{/if}
								{#if g.counts.warning}<Badge variant="info">{t.preview.warnings} : {g.counts.warning}</Badge>{/if}
							</summary>
							<ul class="divide-y border-t">
								{#each g.issues as i, n (`${i.row}-${i.code}-${n}`)}
									<li class="flex min-w-0 flex-wrap items-start gap-2 p-3 text-base" data-testid="ligne-import">
										<span data-severite={i.severity}
											><Badge variant={severityTone[i.severity]}>{t.preview.severity[i.severity]}</Badge></span
										>
										<span class="min-w-0 flex-1 break-words">{i.message}</span>
									</li>
								{/each}
							</ul>
						</details>
					{/each}
				</section>

				<section class="space-y-3 rounded-2xl border bg-card p-4 md:p-6">
					{#if preview.blockers.length}
						<div class="space-y-2" role="status">
							<p class="font-medium">{t.blocked}</p>
							{#each preview.blockers as b (b.code)}
								<p class="rounded-lg bg-warning-soft p-3 text-base text-warning-foreground" data-testid="blocage">{b.message}</p>
							{/each}
						</div>
					{/if}
					<p class="text-base text-muted-foreground">{t.runHelp}</p>
					<Button onclick={run} disabled={!canRun} data-testid="lancer-import"><Play aria-hidden="true" />{t.run}</Button>
				</section>
			{/if}

			{#if reportSheets.length && job.status !== 'analyzed'}
				<section class="min-w-0 space-y-3 rounded-2xl border bg-card p-4 md:p-6" data-testid="rapport">
					<h2 class="text-lg font-semibold">{t.report.title}</h2>
					<ul class="divide-y rounded-xl border">
						{#each reportSheets as s (s.key)}
							<li class="flex min-w-0 flex-wrap items-center justify-between gap-2 p-3" data-testid="rapport-onglet" data-statut={s.status}>
								<span class="font-medium">{IMPORT_SHEET_NAMES[s.key]}</span>
								<span class="flex flex-wrap items-center gap-2">
									{#if s.status === 'done'}<span class="text-base tabular-nums">{t.report.created(s.created)}</span>{/if}
									<Badge variant={s.status === 'done' ? 'success' : s.status === 'failed' ? 'danger' : 'secondary'}
										>{t.report.sheetStatus[s.status]}</Badge
									>
								</span>
								{#if s.message}<p class="w-full text-sm break-words text-muted-foreground">{s.message}</p>{/if}
							</li>
						{/each}
					</ul>
					<div class="flex flex-wrap gap-2">
						{#if job.report?.file}
							<Button variant="outline" onclick={report} disabled={!sync.online} data-testid="telecharger-rapport"
								><Download aria-hidden="true" />{t.report.download}</Button
							>
						{/if}
						{#if job.status === 'completed'}
							<Button variant="outline" href={resolve('/app/import/contrats')} data-testid="lien-contrats-a-deposer"
								><ArrowRight aria-hidden="true" />{t.report.contracts}</Button
							>
						{/if}
					</div>
				</section>
			{/if}

			{#if awaitingCancel}<FormAlert message={t.cancel.waiting} tone="info" />{/if}
			{#if job.status === 'completed' && job.cancellableUntil && !awaitingCancel}
				<section class="space-y-3 rounded-2xl border bg-card p-4 md:p-6">
					<p class="text-base" data-testid="delai-annulation">{t.cancel.until(formatDate(job.cancellableUntil))}</p>
					{#if !cancelOpen}
						<Button variant="outline" onclick={() => (cancelOpen = true)} disabled={!sync.online} data-testid="annuler-import"
							><Undo2 aria-hidden="true" />{t.cancel.action}</Button
						>
					{:else}
						<form class="space-y-3" onsubmit={cancel} novalidate>
							<h2 class="text-lg font-semibold">{t.cancel.title}</h2>
							<p class="text-base text-muted-foreground">{t.cancel.help}</p>
							<label for="motif-annulation" class="block font-medium">{t.cancel.reason}</label>
							<textarea id="motif-annulation" class="{field} min-h-24 py-2" bind:value={reason} data-testid="motif-annulation"></textarea>
							<div class="flex flex-wrap gap-2">
								<Button type="submit" variant="destructive" disabled={acting || reason.trim().length < 3} data-testid="confirmer-annulation"
									>{t.cancel.confirm}</Button
								>
								<Button variant="outline" onclick={() => (cancelOpen = false)}>{fr.app.close}</Button>
							</div>
						</form>
					{/if}
				</section>
			{/if}
		{/if}
		{#snippet fallback()}<FormAlert message={t.unavailable} tone="info" />{/snippet}
	</FeatureGate>
</main>
