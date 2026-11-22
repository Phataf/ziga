<script lang="ts">
	/**
	 * Contrats et documents du propriétaire (lot 10 ter, étape 3b) : ceux de ses biens et de leurs baux que la matrice par
	 * type lui ouvre (D22 : le bail signé et ses avenants, jamais la pièce d'identité du locataire). Chaque document s'ouvre
	 * par un lien signé de courte durée ; chaque téléchargement est journalisé dans l'organisation.
	 */
	import { onMount } from 'svelte';
	import { FileText } from '@lucide/svelte';
	import { formatDate } from '@ziga/shared/dates';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import RemoteState from '#lib/components/portals/RemoteState.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { propertyNames, type OwnerAssetsOrganization } from '#lib/portals/owner.ts';
	import { openSigned, Remote } from '#lib/portals/remote.svelte.ts';

	interface OwnerDocument {
		organizationId: string;
		organizationName: string;
		id: string;
		type: string;
		fileName: string;
		propertyId: string | null;
		activatedAt: string | null;
	}

	const t = fr.ownerSpace;
	const types = fr.documents.types as Record<string, string>;
	const remote = new Remote<OwnerDocument[]>('/me/portal/owner/documents');
	const assets = new Remote<{ organizations: OwnerAssetsOrganization[] }>('/me/portal/owner/assets');
	onMount(() => void Promise.all([remote.load(), assets.load()]));
	const rows = $derived(remote.data ?? []);
	const names = $derived(propertyNames(assets.data?.organizations ?? []));
	let message = $state<string | null>(null);
	let busy = $state<string | null>(null);

	async function open(d: OwnerDocument) {
		message = null;
		busy = d.id;
		try {
			await openSigned(`/me/portal/documents/${d.organizationId}/${d.id}/download`, { space: 'owner' });
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = null;
		}
	}
</script>

{#snippet action(d: OwnerDocument)}
	<Button variant="outline" onclick={() => open(d)} disabled={busy !== null} data-testid="document-consulter">
		<FileText class="size-5" aria-hidden="true" />{t.open}
	</Button>
{/snippet}

<PageHeader title={t.documentsTitle} subtitle={t.documentsSubtitle} />

<main class="page space-y-4 pt-3 pb-10" data-testid="documents-proprietaire">
	<p class="text-base text-muted-foreground">{t.linkTtl}</p>
	<RemoteState {remote}>
		<FormAlert {message} />
		{#if !rows.length}
			<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground" data-testid="documents-vide">{t.noDocument}</p>
		{:else if device.isDesktop}
			<div class="overflow-x-auto rounded-xl border bg-card">
				<table class="w-full text-left text-base">
					<thead class="border-b text-muted-foreground">
						<tr>
							<th class="px-4 py-3 font-medium">{t.document}</th>
							<th class="px-4 py-3 font-medium">{t.property}</th>
							<th class="px-4 py-3 font-medium">{t.manager}</th>
							<th class="px-4 py-3"><span class="sr-only">{t.open}</span></th>
						</tr>
					</thead>
					<tbody class="divide-y">
						{#each rows as d (d.id)}
							<tr data-testid="document-proprietaire" data-type={d.type}>
								<td class="px-4 py-3">
									<span class="block font-medium">{types[d.type] ?? d.type}</span>
									<span class="block text-sm break-all text-muted-foreground">{d.fileName}</span>
								</td>
								<td class="px-4 py-3">{d.propertyId ? (names.get(d.propertyId) ?? '') : ''}</td>
								<td class="px-4 py-3">{d.organizationName}</td>
								<td class="px-4 py-3 text-right">{@render action(d)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<ul class="space-y-3">
				{#each rows as d (d.id)}
					<li class="space-y-2 rounded-xl border bg-card p-4" data-testid="document-proprietaire" data-type={d.type}>
						<p class="font-semibold break-words">{types[d.type] ?? d.type}</p>
						<p class="text-base break-words text-muted-foreground">
							{#if d.propertyId && names.get(d.propertyId)}{names.get(d.propertyId)}&nbsp;·
							{/if}{d.organizationName}{#if d.activatedAt}&nbsp;·
								{t.addedOn(formatDate(d.activatedAt.slice(0, 10)))}{/if}
						</p>
						{@render action(d)}
					</li>
				{/each}
			</ul>
		{/if}
	</RemoteState>
</main>
