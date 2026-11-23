<script lang="ts">
	/**
	 * Import Excel (lot 11) : modèle à télécharger, envoi du fichier avec la date de bascule, imports précédents.
	 * En ligne seulement (écart prévu au plan) : le fichier part directement au stockage par une URL signée, puis le
	 * serveur le lit et le vérifie en tâche de fond ; l'écran de l'import suit l'analyse. Direction et gestion
	 * (`import.run`), fonctionnalité `imports.excel` ; le serveur le vérifie de toute façon.
	 */
	import { onMount } from 'svelte';
	import { FileSpreadsheet, Upload } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { formatDate, toIsoDate } from '@ziga/shared/dates';
	import { newId } from '@ziga/shared/ids';
	import { defaultSwitchOn } from '@ziga/shared/import-plan';
	import { IMPORT_MIME_TYPES, type ImportJobView } from '@ziga/shared/imports';
	import { can } from '@ziga/shared/permissions';
	import type { RentBillingMode } from '@ziga/shared/rent-schedule';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import FeatureGate from '#lib/components/FeatureGate.svelte';
	import ImportStatusBadge from '#lib/components/imports/ImportStatusBadge.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { checkImportFile, switchDateChoices } from '#lib/imports/views.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { downloadFromApi, organizations } from '#lib/org/organizations.svelte.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';

	type Row = Record<string, unknown>;
	const t = fr.imports;
	const today = toIsoDate();
	const role = $derived(organizations.active?.role);
	const allowed = $derived(can(role, 'import.run'));
	const field = 'min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 text-base';

	let billingMode = $state<RentBillingMode>('calendar_prorata');
	let switchOn = $state(defaultSwitchOn(today));
	let file = $state<File | null>(null);
	let busy = $state(false);
	let message = $state<string | null>(null);
	let jobs = $state<ImportJobView[]>([]);

	const choices = $derived(switchDateChoices(today, billingMode));

	onMount(() => {
		const org = organizations.activeId;
		const stop = sync.watch<Row>(LOCAL_QUERIES.organization, [org], (rows) => {
			const mode = rows[0]?.rent_billing_mode;
			if (mode === 'calendar_prorata' || mode === 'calendar_full_first' || mode === 'anniversary') billingMode = mode;
		});
		if (allowed) void loadJobs();
		return stop;
	});

	async function loadJobs() {
		try {
			jobs = await organizations.call<ImportJobView[]>('GET', '/imports');
		} catch {
			// Hors connexion : la liste reviendra avec la connexion ; l'envoi est désactivé.
		}
	}

	async function template() {
		message = null;
		try {
			await downloadFromApi('/imports/template', 'modele-import-ziga.xlsx');
		} catch (error) {
			message = messageOf(error);
		}
	}

	function pick(event: Event) {
		file = (event.currentTarget as HTMLInputElement).files?.[0] ?? null;
		message = null;
	}

	async function send(event: SubmitEvent) {
		event.preventDefault();
		message = null;
		if (!file) return void (message = t.send.badFormat);
		const checked = checkImportFile(file);
		if ('error' in checked) return void (message = checked.error);
		busy = true;
		try {
			const id = newId();
			const created = await organizations.call<{ job: ImportJobView; upload: { url: string; headers: Record<string, string> } }>(
				'POST',
				'/imports',
				{ id, fileName: file.name, fileFormat: checked.format, fileSize: file.size, switchOn }
			);
			const put = await fetch(created.upload.url, {
				method: 'PUT',
				body: file,
				headers: { 'content-type': created.upload.headers['content-type'] ?? IMPORT_MIME_TYPES[checked.format] }
			});
			if (!put.ok) throw new Error(t.send.uploadFailed);
			await organizations.call('POST', `/imports/${id}/analyze`, {});
			await goto(resolve('/app/import/[id]', { id }));
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}
</script>

<PageHeader title={t.title} subtitle={t.subtitle} />

<main class="page space-y-4 pt-3 pb-10" data-testid="import">
	<FeatureGate key="imports.excel">
		{#if !allowed}
			<FormAlert message={t.noAccess} />
		{:else}
			<p class="rounded-lg bg-info-soft p-3 text-base text-info-foreground" data-testid="en-ligne-seulement">{t.online}</p>
			{#if !sync.online}
				<p role="status" class="rounded-lg bg-warning-soft p-3 text-base text-warning-foreground" data-testid="hors-ligne-import">
					{t.offline}
				</p>
			{/if}
			<FormAlert {message} />

			<div class="grid min-w-0 gap-4 lg:grid-cols-2">
				<section class="min-w-0 space-y-3 rounded-2xl border bg-card p-4 md:p-6">
					<h2 class="text-lg font-semibold">{t.template.title}</h2>
					<p class="text-base text-muted-foreground">{t.template.help}</p>
					<Button variant="outline" onclick={template} disabled={!sync.online} data-testid="telecharger-modele"
						><FileSpreadsheet aria-hidden="true" />{t.template.download}</Button
					>
				</section>

				<form class="min-w-0 space-y-4 rounded-2xl border bg-card p-4 md:p-6" onsubmit={send} novalidate data-testid="envoi-import">
					<h2 class="text-lg font-semibold">{t.send.title}</h2>
					<div class="space-y-1">
						<label for="date-bascule" class="block font-medium">{t.send.switchOn}</label>
						{#if choices}
							<select id="date-bascule" class={field} bind:value={switchOn} data-testid="date-bascule">
								{#each choices as d (d)}<option value={d}>{formatDate(d)}</option>{/each}
							</select>
						{:else}
							<input id="date-bascule" type="date" max={today} class={field} bind:value={switchOn} data-testid="date-bascule" />
						{/if}
						<p class="text-sm text-muted-foreground" data-testid="aide-bascule">
							{choices ? t.send.switchFullFirst : t.send.switchHelp}
						</p>
					</div>
					<div class="space-y-1">
						<label for="fichier-import" class="block font-medium">{t.send.file}</label>
						<input
							id="fichier-import"
							type="file"
							accept=".xlsx,.csv,{IMPORT_MIME_TYPES.xlsx},{IMPORT_MIME_TYPES.csv}"
							class="block w-full min-w-0 text-base file:mr-3 file:min-h-11 file:rounded-lg file:border-0 file:bg-secondary file:px-4 file:font-medium"
							onchange={pick}
							data-testid="fichier-import"
						/>
					</div>
					<Button type="submit" disabled={busy || !sync.online || !file} data-testid="envoyer-import"
						><Upload aria-hidden="true" />{busy ? t.send.sending : t.send.submit}</Button
					>
				</form>
			</div>

			<section class="space-y-3 rounded-2xl border bg-card p-4 md:p-6" data-testid="imports-precedents">
				<h2 class="text-lg font-semibold">{t.history}</h2>
				{#if !jobs.length}
					<p class="text-base text-muted-foreground">{t.none}</p>
				{:else}
					<ul class="divide-y rounded-xl border">
						{#each jobs as job (job.id)}
							<li>
								<a
									href={resolve('/app/import/[id]', { id: job.id })}
									class="flex min-h-11 flex-wrap items-center justify-between gap-2 p-3 hover:bg-accent"
									data-testid="import-ligne"
								>
									<span class="min-w-0 space-y-0.5">
										<span class="block font-medium break-all">{job.fileName}</span>
										<span class="block text-sm text-muted-foreground"
											>{t.createdOn(formatDate(job.createdAt))} · {t.switchOnLabel(formatDate(job.switchOn))}</span
										>
									</span>
									<ImportStatusBadge status={job.status} />
								</a>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}
		{#snippet fallback()}<FormAlert message={t.unavailable} tone="info" />{/snippet}
	</FeatureGate>
</main>
