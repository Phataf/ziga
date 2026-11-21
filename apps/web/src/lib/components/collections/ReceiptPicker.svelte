<script lang="ts">
	/**
	 * Justificatif d'une dépense (lot 10 bis, étape 0) : photos du devis ou de la facture, ou PDF, réunis en un seul PDF
	 * compressé sur l'appareil (comme le scan d'un contrat, lot 08 bis). Le choix se fait hors ligne ; l'assemblage a
	 * lieu à l'enregistrement (`assembleReceipt`), puis le fichier part par la file de l'appareil.
	 */
	import { ArrowUp, Camera, FileUp, Trash2 } from '@lucide/svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { fr } from '#lib/i18n/fr.ts';

	let {
		files = $bindable([]),
		title,
		hint,
		testid = 'justificatif'
	}: { files: File[]; title?: string; hint?: string; testid?: string } = $props();
	const t = fr.expenses.receipt;

	function add(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		files = [...files, ...Array.from(input.files ?? [])];
		input.value = '';
	}

	function move(i: number) {
		if (i === 0) return;
		const next = [...files];
		[next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
		files = next;
	}

	const label =
		'inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border-2 border-input px-4 font-medium focus-within:outline-2 focus-within:outline-ring';
</script>

<fieldset class="space-y-2" data-testid={testid}>
	<legend class="text-base font-medium">{title ?? t.title}</legend>
	<p class="text-sm text-muted-foreground">{hint ?? t.hint}</p>
	<div class="flex flex-wrap gap-2">
		<label class={label}>
			<Camera class="size-5" aria-hidden="true" />{t.takePhoto}
			<input type="file" accept="image/*" capture="environment" class="sr-only" onchange={add} data-testid="justificatif-photo" />
		</label>
		<label class={label}>
			<FileUp class="size-5" aria-hidden="true" />{t.addFiles}
			<input
				type="file"
				accept="application/pdf,image/jpeg,image/png"
				multiple
				class="sr-only"
				onchange={add}
				data-testid="justificatif-fichiers"
			/>
		</label>
	</div>
	{#if files.length}
		<p class="text-sm text-muted-foreground" data-testid="justificatif-pieces">{t.pageCount(files.length)}</p>
		<ol class="divide-y rounded-lg border">
			{#each files as f, i (i)}
				<li class="flex flex-wrap items-center justify-between gap-2 p-2">
					<span class="min-w-0 text-base break-all">{i + 1}. {f.name}</span>
					<span class="flex gap-1">
						{#if i > 0}<Button variant="ghost" onclick={() => move(i)}><ArrowUp aria-hidden="true" />{t.moveUp}</Button>{/if}
						<Button variant="ghost" onclick={() => (files = files.filter((_, j) => j !== i))}
							><Trash2 aria-hidden="true" />{t.remove}</Button
						>
					</span>
				</li>
			{/each}
		</ol>
	{/if}
</fieldset>
