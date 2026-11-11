<script lang="ts">
	/**
	 * Documents privés d'un bien (lot 07, D22) : en ligne seulement. Dépôt : fiche en attente et URL d'envoi signée
	 * (type et taille), envoi direct au stockage, puis le serveur contrôle le fichier et calcule son empreinte.
	 * Consultation : un lien signé de 5 minutes, journalisé. La liste vient des métadonnées synchronisées, que seuls la
	 * direction et la gestion reçoivent (matrice par type ; un document restreint, le directeur seul).
	 */
	import { ExternalLink, FileUp } from '@lucide/svelte';
	import { formatDate } from '@ziga/shared/dates';
	import { DOCUMENT_MIME_TYPES, DOCUMENT_TYPES, type DocumentType, type DocumentView } from '@ziga/shared/documents';
	import { newId } from '@ziga/shared/ids';
	import { can } from '@ziga/shared/permissions';
	import { MAX_UPLOAD_BYTES } from '@ziga/shared/properties';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import CheckField from '#lib/components/owners/CheckField.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';

	let { propertyId, ownerId, documents }: { propertyId: string; ownerId: string; documents: DocumentView[] } = $props();

	const t = fr.documents;
	const role = $derived(organizations.active?.role);
	const canUpload = $derived(can(role, 'document.upload'));
	const canRestrict = $derived(can(role, 'document.restrict'));
	const select = 'min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 text-base';

	let type = $state<DocumentType>('title_deed');
	let restricted = $state(false);
	let file = $state<File | null>(null);
	let message = $state<string | null>(null);
	let busy = $state(false);

	const shown = $derived(documents.filter((d) => d.status !== 'rejected'));

	async function send(event: SubmitEvent) {
		event.preventDefault();
		message = null;
		if (!file) return;
		if (file.size > MAX_UPLOAD_BYTES) return void (message = t.tooLarge);
		if (!(DOCUMENT_MIME_TYPES as readonly string[]).includes(file.type)) return void (message = t.badType);
		busy = true;
		try {
			const created = await organizations.call<{ document: DocumentView; upload: { url: string; headers: Record<string, string> } }>(
				'POST',
				'/documents',
				{
					id: newId(),
					type,
					// Pièce d'identité du propriétaire : rattachée à sa fiche ; les autres pièces, au bien.
					ownerId: type === 'owner_identity' ? ownerId : null,
					propertyId,
					fileName: file.name,
					mimeType: file.type,
					byteSize: file.size,
					restriction: restricted ? 'director_only' : null
				}
			);
			const put = await fetch(created.upload.url, { method: 'PUT', body: file, headers: { 'content-type': file.type } });
			if (!put.ok) throw new Error(t.badType);
			const done = await organizations.call<DocumentView>('POST', `/documents/${created.document.id}/uploaded`);
			if (done.status === 'rejected') message = t.badType;
			file = null;
			restricted = false;
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}

	async function open(id: string) {
		message = null;
		try {
			const { url } = await organizations.call<{ url: string }>('POST', `/documents/${id}/download`);
			window.open(url, '_blank', 'noopener');
		} catch (error) {
			message = messageOf(error);
		}
	}
</script>

<section class="space-y-4 rounded-2xl border bg-card p-4 md:p-6" data-testid="documents">
	<div class="space-y-1">
		<h2 class="text-lg font-semibold">{t.title}</h2>
		<p class="text-base text-muted-foreground">{t.subtitle}</p>
	</div>
	<FormAlert {message} />
	{#if !sync.online}<FormAlert message={t.online} tone="info" />{/if}
	{#if !shown.length}
		<p class="text-base text-muted-foreground">{t.empty}</p>
	{:else}
		<ul class="divide-y rounded-xl border">
			{#each shown as d (d.id)}
				<li class="flex flex-wrap items-center justify-between gap-2 p-3" data-testid="document">
					<span class="min-w-0 space-y-1">
						<span class="block font-medium break-words">{t.types[d.type]} · {d.fileName}</span>
						<span class="block text-sm text-muted-foreground">{t.version(d.version)} · {d.createdAt ? formatDate(d.createdAt) : ''}</span>
					</span>
					<span class="flex flex-wrap items-center gap-2">
						<Badge variant={d.status === 'active' ? 'success' : 'secondary'}>{t.status[d.status]}</Badge>
						{#if d.restriction}<Badge variant="warning">{t.restricted}</Badge>{/if}
						{#if d.status !== 'pending'}
							<Button variant="outline" disabled={!sync.online} onclick={() => open(d.id)}
								><ExternalLink aria-hidden="true" />{t.open}</Button
							>
						{/if}
					</span>
				</li>
			{/each}
		</ul>
	{/if}
	{#if canUpload}
		<form class="space-y-3 border-t pt-4" onsubmit={send} novalidate data-testid="ajout-document">
			<h3 class="font-semibold">{t.add}</h3>
			<div class="space-y-1">
				<label for="document-type" class="block font-medium">{t.type}</label>
				<select id="document-type" bind:value={type} class={select}>
					{#each DOCUMENT_TYPES as d (d)}<option value={d}>{t.types[d]}</option>{/each}
				</select>
			</div>
			<div class="space-y-1">
				<label for="document-fichier" class="block font-medium">{t.file}</label>
				<input
					id="document-fichier"
					type="file"
					accept={DOCUMENT_MIME_TYPES.join(',')}
					class="block min-h-12 w-full text-base"
					onchange={(e) => (file = (e.currentTarget as HTMLInputElement).files?.[0] ?? null)}
				/>
			</div>
			{#if canRestrict}<CheckField bind:checked={restricted} label={t.restricted} />{/if}
			<Button type="submit" disabled={busy || !file || !sync.online}><FileUp aria-hidden="true" />{busy ? t.sending : t.send}</Button>
		</form>
	{/if}
</section>
