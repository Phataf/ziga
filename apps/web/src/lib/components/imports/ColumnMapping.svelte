<script lang="ts">
	/**
	 * Fichier libre sur une seule feuille (lot 11, étape 4b) : la personne relie les colonnes de sa feuille aux champs
	 * de plusieurs onglets du modèle à la fois, et donne une valeur commune aux champs absents de son fichier. Sur
	 * ordinateur, une colonne se glisse vers un champ ; sur tous les appareils, chaque champ a sa liste des colonnes.
	 * Les références entre onglets ne sont jamais demandées : l'analyse les déduit des lignes (shared).
	 */
	import { untrack } from 'svelte';
	import { GripVertical, RefreshCw, X } from '@lucide/svelte';
	import { IMPORT_SHEET_NAMES, type ImportSheetKey } from '@ziga/shared/import-template';
	import {
		singleSheetMissing,
		singleSheetTargets,
		type SingleSheetMapping,
		type SingleSheetTarget
	} from '@ziga/shared/import-single-sheet';
	import type { ImportJobView } from '@ziga/shared/imports';
	import type { OrganizationType } from '@ziga/shared/permissions';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { device } from '#lib/device.svelte.ts';
	import { initialSingleMapping, withColumn, withConstant } from '#lib/imports/single-sheet.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { cn } from '#lib/utils.ts';

	let {
		job,
		type,
		disabled = false,
		onapply
	}: { job: ImportJobView; type: OrganizationType; disabled?: boolean; onapply: (mapping: SingleSheetMapping) => Promise<void> } = $props();

	const t = fr.imports.mapping;
	const field = 'min-h-11 w-full min-w-0 rounded-lg border-2 border-input bg-card px-3 text-base';
	/** Champs facultatifs courants, montrés d'emblée ; les autres sous « Autres champs ». */
	const COMMON = new Set([
		'tenants.phone',
		'tenants.civility',
		'properties.commune',
		'properties.neighborhood',
		'properties.commissionRate',
		'units.rent',
		'units.charges',
		'leases.charges',
		'leases.endsOn',
		'deposits.agreedAmount',
		'deposits.receivedAmount',
		'opening_balances.amount'
	]);

	// Point de départ seulement : la saisie garde son état ; une nouvelle analyse remonte le composant.
	let mapping = $state<SingleSheetMapping>(untrack(() => initialSingleMapping(job)));
	let busy = $state(false);
	let dragging = $state<string | null>(null);

	const files = $derived(job.preview?.fileSheets ?? []);
	const file = $derived(files.find((f) => f.name === mapping.sheet) ?? files[0]);
	const targets = $derived(singleSheetTargets(type));
	const missing = $derived(singleSheetMissing(mapping, type));
	const groups = $derived(
		[...new Set(targets.map((x) => x.sheet))].map((sheet) => {
			const mine = targets.filter((x) => x.sheet === sheet);
			const shown = (x: SingleSheetTarget) =>
				x.required || COMMON.has(x.id) || mapping.columns[x.id] !== undefined || mapping.constants[x.id] !== undefined;
			return { sheet: sheet as ImportSheetKey, main: mine.filter(shown), others: mine.filter((x) => !shown(x)) };
		})
	);

	const columnName = (i: number) => file?.headers[i] || t.columnN(i + 1);

	function chooseSheet(name: string) {
		mapping = initialSingleMapping(job, name);
	}

	function drop(event: DragEvent, target: string) {
		event.preventDefault();
		dragging = null;
		const col = Number(event.dataTransfer?.getData('text/plain'));
		if (Number.isInteger(col) && col >= 0) mapping = withColumn(mapping, target, col);
	}

	async function apply() {
		busy = true;
		try {
			await onapply(mapping);
		} finally {
			busy = false;
		}
	}

	const inputType = (x: SingleSheetTarget) => (x.field.kind === 'date' ? 'date' : 'text');
	const inputMode = (x: SingleSheetTarget) => (['percent', 'integer', 'amount'].includes(x.field.kind) ? 'decimal' : undefined);
	const choicesOf = (x: SingleSheetTarget) =>
		x.field.kind === 'boolean' ? [{ label: 'Oui' }, { label: 'Non' }] : x.field.kind === 'choice' ? (x.field.choices ?? []) : null;
</script>

{#snippet target(x: SingleSheetTarget)}
	{@const col = mapping.columns[x.id]}
	{@const choices = choicesOf(x)}
	<li
		class={cn(
			'min-w-0 space-y-2 rounded-xl border p-3',
			device.isDesktop && dragging !== null && 'border-dashed border-primary',
			col !== undefined && 'bg-secondary/40'
		)}
		data-testid="cible"
		data-cible={x.id}
		data-colonne={col}
		ondragover={device.isDesktop ? (e) => e.preventDefault() : undefined}
		ondrop={device.isDesktop ? (e) => drop(e, x.id) : undefined}
	>
		<p class="font-medium break-words">
			{x.field.header}{#if x.required}<span class="text-sm text-muted-foreground"> · {t.required}</span>{/if}
		</p>
		<div class="grid min-w-0 gap-2 sm:grid-cols-2">
			<label class="min-w-0 space-y-1">
				<span class="block text-sm text-muted-foreground">{device.isDesktop ? t.columnOrDrop : t.column}</span>
				<select
					class={field}
					value={col === undefined ? '' : String(col)}
					onchange={(e) => (mapping = withColumn(mapping, x.id, e.currentTarget.value === '' ? null : Number(e.currentTarget.value)))}
					data-testid="cible-colonne"
				>
					<option value="">{t.noColumn}</option>
					{#each file?.headers ?? [] as _, i (i)}<option value={String(i)}>{columnName(i)}</option>{/each}
				</select>
			</label>
			{#if x.constantAllowed}
				<label class="min-w-0 space-y-1">
					<span class="block text-sm text-muted-foreground">{t.constant}</span>
					{#if choices}
						<select
							class={field}
							value={mapping.constants[x.id] ?? ''}
							onchange={(e) => (mapping = withConstant(mapping, x.id, e.currentTarget.value))}
							data-testid="valeur-commune"
						>
							<option value="">{t.noConstant}</option>
							{#each choices as c (c.label)}<option value={c.label}>{c.label}</option>{/each}
						</select>
					{:else}
						<input
							class={field}
							type={inputType(x)}
							inputmode={inputMode(x)}
							value={mapping.constants[x.id] ?? ''}
							onchange={(e) => (mapping = withConstant(mapping, x.id, e.currentTarget.value))}
							data-testid="valeur-commune"
						/>
					{/if}
				</label>
			{/if}
		</div>
		{#if col !== undefined}
			<p class="flex flex-wrap items-center gap-2 text-sm">
				<span class="break-words">{t.linked(columnName(col))}</span>
				<Button variant="ghost" onclick={() => (mapping = withColumn(mapping, x.id, null))}><X aria-hidden="true" />{t.unlink}</Button>
			</p>
		{/if}
	</li>
{/snippet}

{#snippet columnsList()}
	{#if file}
		<div class="space-y-2">
			<h3 class="font-medium">{t.fileColumns(file.name, file.rows)}</h3>
			<ul class={cn('min-w-0 gap-2', device.isDesktop ? 'grid' : 'grid sm:grid-cols-2')}>
				{#each file.headers as header, i (i)}
					<li
						class={cn(
							'flex min-h-11 min-w-0 items-start gap-2 rounded-lg border bg-background px-3 py-2',
							device.isDesktop && 'cursor-grab'
						)}
						draggable={device.isDesktop ? 'true' : undefined}
						ondragstart={device.isDesktop
							? (e) => {
									e.dataTransfer?.setData('text/plain', String(i));
									dragging = String(i);
								}
							: undefined}
						ondragend={() => (dragging = null)}
						data-testid="colonne-fichier"
						data-index={i}
					>
						{#if device.isDesktop}<GripVertical class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />{/if}
						<span class="min-w-0">
							<span class="block font-medium break-words">{header || t.columnN(i + 1)}</span>
							{#if file.samples[0]?.[i]}<span class="block text-sm break-words text-muted-foreground">{t.example(file.samples[0][i]!)}</span
								>{/if}
						</span>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
{/snippet}

{#snippet fieldsList()}
	{#each groups as g (g.sheet)}
		<div class="space-y-2">
			<h3 class="font-semibold">{IMPORT_SHEET_NAMES[g.sheet]}</h3>
			<ul class="grid gap-2 lg:grid-cols-2">
				{#each g.main as x (x.id)}{@render target(x)}{/each}
			</ul>
			{#if g.others.length}
				<details class="rounded-xl border">
					<summary class="flex min-h-11 cursor-pointer items-center px-3 text-base">{t.others(g.others.length)}</summary>
					<ul class="grid gap-2 p-3 lg:grid-cols-2">
						{#each g.others as x (x.id)}{@render target(x)}{/each}
					</ul>
				</details>
			{/if}
		</div>
	{/each}
{/snippet}

<section class="min-w-0 space-y-4 rounded-2xl border bg-card p-4 md:p-6" data-testid="correspondance">
	<div class="space-y-1">
		<h2 class="text-lg font-semibold">{t.title}</h2>
		<p class="text-base text-muted-foreground">{device.isDesktop ? t.helpDesktop : t.help}</p>
	</div>

	{#if files.length > 1}
		<label class="block max-w-md space-y-1">
			<span class="block font-medium">{t.sheet}</span>
			<select class={field} value={mapping.sheet} onchange={(e) => chooseSheet(e.currentTarget.value)} data-testid="feuille-choix">
				{#each files as f (f.name)}<option value={f.name}>{t.sheetRows(f.name, f.rows)}</option>{/each}
			</select>
		</label>
	{/if}

	{#if device.isDesktop}
		<!-- Ordinateur : les champs à gauche, les colonnes du fichier à droite, toujours visibles pendant qu'on glisse. -->
		<div class="grid grid-cols-[minmax(0,1fr)_18rem] items-start gap-6">
			<div class="min-w-0 space-y-4">{@render fieldsList()}</div>
			<aside class="sticky top-20 max-h-[calc(100vh-7rem)] min-w-0 overflow-y-auto">{@render columnsList()}</aside>
		</div>
	{:else}
		{@render columnsList()}
		{@render fieldsList()}
	{/if}

	{#if missing.length}
		<div class="space-y-1 rounded-lg bg-warning-soft p-3 text-warning-foreground" role="status">
			<p class="font-medium">{t.missing}</p>
			<ul class="list-disc pl-5">
				{#each missing as m (m.id)}<li data-testid="champ-manquant">{m.field.header} ({IMPORT_SHEET_NAMES[m.sheet]})</li>{/each}
			</ul>
		</div>
	{/if}

	<Button onclick={apply} disabled={disabled || busy} data-testid="appliquer-correspondance"
		><RefreshCw aria-hidden="true" />{t.apply}</Button
	>
</section>
