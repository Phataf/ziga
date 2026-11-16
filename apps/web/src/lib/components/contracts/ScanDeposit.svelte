<script lang="ts">
	/**
	 * Dépôt du scan signé (lot 08 bis, D21) : photos des pages ou PDF, réunis en un seul PDF compressé sur l'appareil
	 * (pdf-lib, chargé à la demande), avec la date de signature de chaque partie attendue. Le scan entre dans la file de
	 * l'appareil et part dès la connexion : il se prépare hors ligne. Il est enregistré comme « Signature manuscrite, scan
	 * déposé par … le … », jamais comme une signature électronique.
	 */
	import { ArrowUp, Camera, FileUp, Trash2 } from '@lucide/svelte';
	import { toIsoDate } from '@ziga/shared/dates';
	import type { ContractParty, ContractView } from '@ziga/shared/contracts';
	import { newId } from '@ziga/shared/ids';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { scanQueue } from '#lib/contracts/scan-queue.svelte.ts';
	import { assembleScanPdf, type ScanPart, type ScanPartType } from '#lib/contracts/scan.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { compressPhoto } from '#lib/properties/photos.ts';

	let { contract, done }: { contract: ContractView; done: () => void } = $props();

	const t = fr.contracts;
	const s = t.scan;
	const today = toIsoDate();
	const signers = $derived<ContractParty[]>(contract.expectedSigners ?? ['organization', 'tenant']);
	const frozenOn = $derived(contract.frozenAt ? contract.frozenAt.slice(0, 10) : today);

	let files = $state<File[]>([]);
	let dates = $state<Record<string, string>>({});
	let message = $state<string | null>(null);
	let busy = $state(false);

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

	async function part(file: File): Promise<ScanPart> {
		if (file.type === 'application/pdf') return { type: 'application/pdf', bytes: new Uint8Array(await file.arrayBuffer()) };
		if (!file.type.startsWith('image/')) throw Object.assign(new Error('UNSUPPORTED'), { code: 'UNSUPPORTED' });
		// Photo : réduite et compressée en JPEG (métadonnées retirées) avant d'entrer dans le PDF.
		const jpeg = await compressPhoto(file).catch(() => {
			throw Object.assign(new Error('UNREADABLE'), { code: 'UNREADABLE' });
		});
		return { type: 'image/jpeg' as ScanPartType, bytes: new Uint8Array(await jpeg.arrayBuffer()) };
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		message = null;
		const signedOn: Record<ContractParty, string | null> = { organization: null, owner: null, tenant: null };
		for (const p of signers) signedOn[p] = dates[p] || null;
		if (signers.some((p) => !signedOn[p] || signedOn[p]! > today || signedOn[p]! < frozenOn)) return void (message = s.dateRequired);
		if (!files.length) return void (message = s.errors.EMPTY!);
		if (!contract.frozenVersion) return;
		busy = true;
		try {
			const pdf = await assembleScanPdf(await Promise.all(files.map(part)));
			await scanQueue.add({
				id: newId(),
				organizationId: organizations.activeId!,
				contractId: contract.id,
				expectedVersion: contract.frozenVersion,
				signedOn,
				blob: new Blob([pdf as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }),
				fileName: `contrat-signe-v${contract.frozenVersion}.pdf`
			});
			files = [];
			done();
		} catch (error) {
			const code = (error as { code?: string }).code;
			message = (code && s.errors[code]) || s.errors.UNREADABLE!;
		} finally {
			busy = false;
		}
	}
</script>

<form class="space-y-4 rounded-xl border p-4" onsubmit={submit} novalidate data-testid="formulaire-scan">
	<div class="space-y-1">
		<h3 class="font-semibold">{s.title}</h3>
		<p class="text-sm text-muted-foreground">{s.hint}</p>
	</div>
	<FormAlert {message} />
	<div class="flex flex-wrap gap-2">
		<label
			class="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border-2 border-input px-4 font-medium focus-within:outline-2 focus-within:outline-ring"
		>
			<Camera class="size-5" aria-hidden="true" />{s.takePhoto}
			<input type="file" accept="image/*" capture="environment" class="sr-only" onchange={add} data-testid="photo-page" />
		</label>
		<label
			class="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border-2 border-input px-4 font-medium focus-within:outline-2 focus-within:outline-ring"
		>
			<FileUp class="size-5" aria-hidden="true" />{s.addPages}
			<input
				type="file"
				accept="application/pdf,image/jpeg,image/png"
				multiple
				class="sr-only"
				onchange={add}
				data-testid="fichiers-scan"
			/>
		</label>
	</div>
	{#if files.length}
		<p class="text-sm text-muted-foreground" data-testid="nombre-pieces">{s.pageCount(files.length)}</p>
		<ol class="divide-y rounded-lg border">
			{#each files as f, i (i)}
				<li class="flex flex-wrap items-center justify-between gap-2 p-2">
					<span class="min-w-0 text-base break-all">{i + 1}. {f.name}</span>
					<span class="flex gap-1">
						{#if i > 0}<Button variant="ghost" onclick={() => move(i)}><ArrowUp aria-hidden="true" />{s.moveUp}</Button>{/if}
						<Button variant="ghost" onclick={() => (files = files.filter((_, j) => j !== i))}
							><Trash2 aria-hidden="true" />{s.remove}</Button
						>
					</span>
				</li>
			{/each}
		</ol>
	{/if}
	<div class="grid gap-3 sm:grid-cols-3">
		{#each signers as p (p)}
			<div class="space-y-1">
				<label for={`signe-${p}`} class="block font-medium">{t.parties[p]}</label>
				<Input id={`signe-${p}`} type="date" min={frozenOn} max={today} bind:value={dates[p]} data-testid={`date-${p}`} />
			</div>
		{/each}
	</div>
	<p class="text-sm text-muted-foreground">{s.labelNotice}</p>
	<Button type="submit" disabled={busy} data-testid="enregistrer-scan">{busy ? s.preparing : s.submit}</Button>
</form>
