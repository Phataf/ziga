<script lang="ts">
	/**
	 * Modèles de contrat (lot 08 bis, D23, D25) : modèle en usage pour le bail et pour l'avenant (celui de
	 * l'organisation s'il est actif, sinon celui de la plateforme), dépôt d'un modèle Word et résultat de son contrôle
	 * (refus motivé, balises reconnues et inconnues, polices, pages), aperçu avec des données d'exemple, activation et
	 * retrait. Lecture sur l'appareil ; dépôt et actions en ligne, par la direction seule.
	 */
	import { onMount } from 'svelte';
	import { Archive, CheckCircle2, Eye, FileUp } from '@lucide/svelte';
	import { formatDate } from '@ziga/shared/dates';
	import { CONTRACT_TEMPLATE_KINDS, fieldsForKind, type ContractTemplateKind } from '@ziga/shared/contract-fields';
	import {
		CONTRACT_TEMPLATE_LIMITS,
		createTemplateSchema,
		templateActivationBlocker,
		type ContractTemplateView
	} from '@ziga/shared/contracts';
	import { newId } from '@ziga/shared/ids';
	import { can } from '@ziga/shared/permissions';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { templatesInUse, toTemplate } from '#lib/contracts/views.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';

	type Row = Record<string, unknown>;
	const t = fr.contracts.templates;
	const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
	const role = $derived(organizations.active?.role);
	const allowed = $derived(can(role, 'contract_template.read'));
	const canManage = $derived(can(role, 'contract_template.manage'));
	const select = 'min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 text-base';

	let rows = $state<Row[]>([]);
	let previewRows = $state<Row[]>([]);
	let kind = $state<ContractTemplateKind>('lease');
	let name = $state('');
	let file = $state<File | null>(null);
	let message = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let busy = $state(false);

	onMount(() => {
		if (!allowed) return;
		const org = organizations.activeId;
		const onError = (error: Error) => (message = messageOf(error));
		const stops = [
			sync.watch<Row>(LOCAL_QUERIES.contractTemplates, [org], (r) => (rows = r), onError),
			sync.watch<Row>(LOCAL_QUERIES.templateDocuments, [org], (r) => (previewRows = r), onError)
		];
		return () => stops.forEach((stop) => stop());
	});

	/** Dernier aperçu PDF de chaque modèle (comme le serveur : PDF reçu, rattaché au modèle). */
	const previews = $derived(
		new Map(
			previewRows
				.filter((d) => d.type === 'contract_template' && d.mime_type === 'application/pdf' && d.status === 'active')
				.map((d) => [String(d.contract_template_id), String(d.id)] as const)
				.reverse()
		)
	);
	const templates = $derived<ContractTemplateView[]>(rows.map((r) => toTemplate(r, previews.get(String(r.id)) ?? null)));
	const inUse = $derived(templatesInUse(templates));
	const nameOf = (id: string | null) => templates.find((x) => x.id === id)?.name ?? '';

	async function run(fn: () => Promise<void>, done: string | null = null) {
		message = null;
		notice = null;
		busy = true;
		try {
			await fn();
			notice = done;
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}

	async function upload(event: SubmitEvent) {
		event.preventDefault();
		if (!file) return void (message = t.badFile);
		const parsed = createTemplateSchema.safeParse({
			id: newId(),
			documentId: newId(),
			kind,
			name,
			fileName: file.name,
			byteSize: file.size
		});
		if (!parsed.success) return void (message = parsed.error.issues[0]!.message);
		const chosen = file;
		await run(async () => {
			const created = await organizations.call<{ template: ContractTemplateView; upload: { url: string } }>(
				'POST',
				'/contract-templates',
				parsed.data
			);
			const put = await fetch(created.upload.url, { method: 'PUT', body: chosen, headers: { 'content-type': DOCX } });
			if (!put.ok) throw new Error(t.badFile);
			await organizations.call<ContractTemplateView>('POST', `/contract-templates/${parsed.data.id}/inspect`);
			name = '';
			file = null;
		});
	}

	async function openPreview(documentId: string) {
		await run(async () => {
			const { url } = await organizations.call<{ url: string }>('POST', `/documents/${documentId}/download`);
			window.open(url, '_blank', 'noopener');
		});
	}
</script>

<PageHeader title={t.title} subtitle={t.subtitle} back="app/contrats" backLabel={t.back} />

<main class="page space-y-4 pt-3 pb-10" data-testid="modeles-contrat">
	{#if !allowed}
		<FormAlert message={fr.contracts.noAccess} />
	{:else}
		<FormAlert {message} />
		{#if notice}<FormAlert message={notice} tone="info" />{/if}

		<section class="space-y-3 rounded-2xl border bg-card p-4 md:p-6" data-testid="modeles-en-usage">
			<h2 class="text-lg font-semibold">{t.inUse}</h2>
			<ul class="grid gap-3 sm:grid-cols-2">
				{#each CONTRACT_TEMPLATE_KINDS as k (k)}
					<li class="space-y-2 rounded-xl border p-3" data-testid={`en-usage-${k}`}>
						<p class="font-medium">{t.kinds[k]}</p>
						<p class="text-base">
							{inUse[k].source === 'platform'
								? t.platform(inUse[k].version)
								: t.organization(nameOf(inUse[k].templateId), inUse[k].version)}
						</p>
						{#if inUse[k].legalReviewPending}<FormAlert message={fr.contracts.defaultBanner} tone="info" />{/if}
					</li>
				{/each}
			</ul>
		</section>

		{#if canManage}
			<section class="space-y-3 rounded-2xl border bg-card p-4 md:p-6">
				<div class="space-y-1">
					<h2 class="text-lg font-semibold">{t.upload}</h2>
					<p class="text-sm text-muted-foreground">{t.uploadHint}</p>
				</div>
				{#if !sync.online}
					<FormAlert message={fr.contracts.online} tone="info" />
				{:else}
					<form class="space-y-3" onsubmit={upload} novalidate data-testid="formulaire-modele">
						<div class="grid gap-3 sm:grid-cols-2">
							<div class="space-y-1">
								<label for="nom-modele" class="block font-medium">{t.name}</label>
								<Input id="nom-modele" bind:value={name} />
							</div>
							<div class="space-y-1">
								<label for="type-modele" class="block font-medium">{t.kind}</label>
								<select id="type-modele" class={select} bind:value={kind}>
									{#each CONTRACT_TEMPLATE_KINDS as k (k)}<option value={k}>{t.kinds[k]}</option>{/each}
								</select>
							</div>
						</div>
						<div class="space-y-1">
							<label for="fichier-modele" class="block font-medium">{t.file}</label>
							<input
								id="fichier-modele"
								type="file"
								accept=".docx,{DOCX}"
								class="block min-h-11 w-full text-base"
								data-testid="fichier-modele"
								onchange={(e) => {
									const f = (e.currentTarget as HTMLInputElement).files?.[0] ?? null;
									file = f && f.size <= CONTRACT_TEMPLATE_LIMITS.maxBytes ? f : null;
									if (f && !file) message = t.badFile;
								}}
							/>
						</div>
						<Button type="submit" disabled={busy || !file}><FileUp aria-hidden="true" />{busy ? t.sending : t.submit}</Button>
					</form>
				{/if}
				<details class="rounded-xl border p-3">
					<summary class="min-h-11 cursor-pointer content-center font-medium">{t.fields}</summary>
					<ul class="mt-2 space-y-1 text-base">
						{#each fieldsForKind(kind) as f (f.tag)}
							<li class="break-words"><code class="text-sm">{`{${f.tag}}`}</code> · {f.label}</li>
						{/each}
					</ul>
				</details>
			</section>
		{:else}
			<FormAlert message={t.directorOnly} tone="info" />
		{/if}

		<section class="space-y-3 rounded-2xl border bg-card p-4 md:p-6" data-testid="modeles-deposes">
			<h2 class="text-lg font-semibold">{t.list}</h2>
			{#if !templates.length}
				<p class="text-base text-muted-foreground">{t.empty}</p>
			{:else}
				<ul class="space-y-3">
					{#each templates as tp (tp.id)}
						{@const blocker = templateActivationBlocker({ ...tp, inspected: !!tp.inspectedAt && !tp.inspectionError })}
						<li class="space-y-2 rounded-xl border p-4" data-testid="modele" data-statut={tp.status}>
							<div class="flex flex-wrap items-center justify-between gap-2">
								<span class="font-semibold break-words">{tp.name} · {t.kinds[tp.kind]} · v{tp.version}</span>
								<Badge variant={tp.status === 'active' ? 'success' : tp.inspectionError ? 'danger' : 'secondary'}
									>{t.status[tp.status]}</Badge
								>
							</div>
							<p class="text-sm text-muted-foreground">{formatDate(tp.createdAt)}</p>
							{#if tp.inspectionError}
								<FormAlert message={`${t.refused} : ${tp.inspectionError}`} />
							{:else if !tp.inspectedAt}
								<p class="text-base text-muted-foreground">{t.notInspected}</p>
							{:else}
								<p class="text-base" data-testid="balises-reconnues">
									{t.known(tp.detectedFields.length)}{#if tp.pageCount}
										· {t.pages(tp.pageCount)}{/if}
								</p>
								{#if tp.unknownFields.length}
									<div class="space-y-1 rounded-lg border border-warning p-3" data-testid="balises-inconnues">
										<p class="font-medium">{t.unknown}</p>
										<p class="text-base break-words">{tp.unknownFields.map((f) => `{${f}}`).join(', ')}</p>
									</div>
								{/if}
								{#if tp.unmatchedFonts.length}
									<p class="text-base">{t.fonts} : {tp.unmatchedFonts.join(', ')}</p>
								{/if}
							{/if}
							{#if canManage && sync.online}
								<div class="flex flex-wrap gap-2">
									{#if tp.inspectedAt && !tp.inspectionError && tp.status !== 'retired'}
										<Button
											variant="outline"
											disabled={busy}
											onclick={() => run(() => organizations.call('POST', `/contract-templates/${tp.id}/preview`), t.previewRequested)}
											><Eye aria-hidden="true" />{t.preview}</Button
										>
									{/if}
									{#if tp.previewDocumentId}
										<Button variant="ghost" onclick={() => openPreview(tp.previewDocumentId!)}>{t.openPreview}</Button>
									{/if}
									{#if tp.status === 'draft' && !blocker}
										<Button
											disabled={busy}
											onclick={() => run(() => organizations.call('POST', `/contract-templates/${tp.id}/activate`), t.activated)}
											data-testid="activer-modele"><CheckCircle2 aria-hidden="true" />{t.activate}</Button
										>
									{/if}
									{#if tp.status === 'active'}
										<Button
											variant="outline"
											disabled={busy}
											onclick={() => run(() => organizations.call('POST', `/contract-templates/${tp.id}/retire`), t.retired)}
											><Archive aria-hidden="true" />{t.retire}</Button
										>
									{/if}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}
</main>
