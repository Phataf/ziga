<script lang="ts">
	/**
	 * Galerie d'un bien ou d'une unité (lot 07) : photos prêtes (miniature servie par l'API), photos en file d'envoi
	 * (aperçu local, même hors ligne), photos refusées (motif). Ajout depuis l'appareil photo ou la galerie : chaque
	 * photo est compressée sur le téléphone, mise en file, et sa fiche part par la synchronisation. Réordonner par
	 * « Avancer » et « Reculer » (cibles de 44 px, au clavier aussi).
	 */
	import { ArrowDown, ArrowUp, Camera, ImageOff, Trash2 } from '@lucide/svelte';
	import { PUBLIC_API_URL } from '$app/env/public';
	import { newId } from '@ziga/shared/ids';
	import { MAX_PHOTOS_PER_OBJECT, type MediaView } from '@ziga/shared/properties';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { photoQueue } from '#lib/properties/photo-queue.svelte.ts';
	import { compressPhoto, precheck } from '#lib/properties/photos.ts';
	import { reorder } from '#lib/properties/views.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';
	import { createMedia, removeMedia, reorderMedia } from '#lib/sync/writes.ts';

	let {
		propertyId,
		unitId = null,
		label,
		gallery,
		canEdit,
		testid = 'galerie'
	}: { propertyId: string; unitId?: string | null; label: string; gallery: MediaView[]; canEdit: boolean; testid?: string } = $props();

	const t = fr.photos;
	let message = $state<string | null>(null);
	let busy = $state(false);
	let input = $state<HTMLInputElement | null>(null);
	const full = $derived(gallery.length >= MAX_PHOTOS_PER_OBJECT);

	async function db() {
		return sync.db ?? (await sync.start());
	}

	async function add(event: Event) {
		const files = [...((event.currentTarget as HTMLInputElement).files ?? [])];
		(event.currentTarget as HTMLInputElement).value = '';
		const organizationId = organizations.activeId;
		if (!files.length || !organizationId) return;
		message = null;
		busy = true;
		const problems: string[] = [];
		try {
			let position = gallery.length ? Math.max(...gallery.map((m) => m.position)) + 1 : 0;
			for (const file of files.slice(0, MAX_PHOTOS_PER_OBJECT - gallery.length)) {
				if (precheck(file)) {
					problems.push(t.tooLarge(file.name));
					continue;
				}
				let blob: Blob;
				try {
					blob = await compressPhoto(file);
				} catch {
					problems.push(t.unreadable(file.name));
					continue;
				}
				const id = newId();
				await createMedia(await db(), organizationId, {
					id,
					propertyId,
					unitId,
					mimeType: 'image/jpeg',
					byteSize: blob.size,
					caption: null,
					position: position++
				});
				await photoQueue.add({ id, organizationId, blob, createdAt: Date.now() });
			}
			if (files.length > MAX_PHOTOS_PER_OBJECT - gallery.length) problems.push(t.full);
		} catch (error) {
			problems.push(messageOf(error));
		} finally {
			busy = false;
			message = problems.length ? problems.join(' ') : null;
		}
	}

	async function move(id: string, direction: -1 | 1) {
		const organizationId = organizations.activeId;
		const moves = reorder(gallery, id, direction);
		if (organizationId && moves.length) await reorderMedia(await db(), organizationId, moves);
	}

	async function remove(id: string) {
		const organizationId = organizations.activeId;
		if (organizationId) await removeMedia(await db(), organizationId, id);
	}

	function src(m: MediaView): string | null {
		if (m.variants) return new URL(m.variants[320], PUBLIC_API_URL).toString();
		return photoQueue.previews[m.id] ?? null;
	}

	function stateNote(m: MediaView): string | null {
		if (m.status === 'ready') return null;
		if (m.status === 'rejected') return `${t.rejected} : ${t.rejectedReasons[m.error ?? ''] ?? m.error ?? ''}`;
		if (photoQueue.states[m.id] === 'sending') return t.sending;
		if (photoQueue.states[m.id] === 'queued') return t.queued;
		return t.processing;
	}
</script>

<section class="space-y-3" data-testid={testid}>
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h3 class="font-semibold">
			{label} <span class="text-sm font-normal text-muted-foreground">({t.count(gallery.length, MAX_PHOTOS_PER_OBJECT)})</span>
		</h3>
		{#if canEdit}
			<input
				bind:this={input}
				type="file"
				accept="image/*"
				capture="environment"
				multiple
				class="sr-only"
				tabindex="-1"
				aria-hidden="true"
				onchange={add}
				data-testid="{testid}-fichier"
			/>
			<Button variant="outline" disabled={busy || full} onclick={() => input?.click()}><Camera aria-hidden="true" />{t.add}</Button>
		{/if}
	</div>
	<FormAlert {message} tone="info" />
	{#if !gallery.length}
		<p class="text-base text-muted-foreground">{t.empty}</p>
	{:else}
		<ul class="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
			{#each gallery as m, i (m.id)}
				{@const url = src(m)}
				{@const note = stateNote(m)}
				<li class="space-y-2 rounded-xl border bg-card p-2" data-testid="{testid}-photo" data-status={m.status}>
					<div class="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg bg-muted">
						{#if url}
							<img src={url} alt={t.alt(label, i + 1)} class="size-full object-cover" loading="lazy" />
						{:else}
							<ImageOff class="size-6 text-muted-foreground" aria-hidden="true" />
						{/if}
					</div>
					{#if note}<p class="text-sm text-muted-foreground" data-testid="{testid}-etat">{note}</p>{/if}
					{#if canEdit}
						<div class="flex flex-wrap gap-1">
							<Button variant="ghost" class="px-2" disabled={i === 0} onclick={() => move(m.id, -1)}>
								<ArrowUp aria-hidden="true" />{t.moveUp}
							</Button>
							<Button variant="ghost" class="px-2" disabled={i === gallery.length - 1} onclick={() => move(m.id, 1)}>
								<ArrowDown aria-hidden="true" />{t.moveDown}
							</Button>
							<Button variant="ghost" class="px-2" onclick={() => remove(m.id)}>
								<Trash2 aria-hidden="true" />{t.remove}
							</Button>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>
