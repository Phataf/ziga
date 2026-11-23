<script lang="ts">
	/**
	 * « Contrats à déposer » (lot 11) : baux créés par un import, en vigueur ou réservés, sans contrat signé. Le contrat
	 * papier se dépose scan par scan, par la route des documents (bail signé scanné, rattaché au bail) : le serveur
	 * l'enregistre « signature manuscrite, scan déposé » (D21), jamais comme une signature électronique, et l'alerte
	 * « Contrat non signé » disparaît. Liste lue sur l'appareil ; dépôt en ligne seulement.
	 */
	import { onMount } from 'svelte';
	import { FileUp } from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import { formatDate } from '@ziga/shared/dates';
	import { UPLOAD_MIME_TYPES, type DocumentView } from '@ziga/shared/documents';
	import { newId } from '@ziga/shared/ids';
	import { can } from '@ziga/shared/permissions';
	import { MAX_UPLOAD_BYTES } from '@ziga/shared/properties';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import FeatureGate from '#lib/components/FeatureGate.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { contractsToDeposit } from '#lib/imports/views.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';

	type Row = Record<string, unknown>;
	const t = fr.imports.contracts;
	const role = $derived(organizations.active?.role);
	const allowed = $derived(can(role, 'contract.read') && can(role, 'document.upload'));

	let leaseRows = $state<Row[]>([]);
	let contractRows = $state<Row[]>([]);
	let scans = $state<string[]>([]);
	/** Baux dont le scan vient d'être déposé, retirés tout de suite (la synchronisation suit). */
	let deposited = $state<string[]>([]);
	let files = $state<Record<string, File | null>>({});
	let busy = $state<string | null>(null);
	let message = $state<string | null>(null);
	let info = $state<string | null>(null);

	onMount(() => {
		if (!allowed) return;
		const org = organizations.activeId;
		const onError = (error: Error) => (message = messageOf(error));
		const stops = [
			sync.watch<Row>(LOCAL_QUERIES.contractLeases, [org], (r) => (leaseRows = r), onError),
			sync.watch<Row>(LOCAL_QUERIES.contracts, [org], (r) => (contractRows = r), onError),
			sync.watch<Row>(LOCAL_QUERIES.signedScans, [org], (r) => (scans = r.map((x) => String(x.lease_id))), onError)
		];
		return () => stops.forEach((s) => s());
	});

	const items = $derived(contractsToDeposit(leaseRows, contractRows, [...scans, ...deposited]));

	function pick(leaseId: string, event: Event) {
		files = { ...files, [leaseId]: (event.currentTarget as HTMLInputElement).files?.[0] ?? null };
	}

	async function deposit(leaseId: string) {
		const file = files[leaseId];
		message = null;
		info = null;
		if (!file) return;
		if (file.size > MAX_UPLOAD_BYTES) return void (message = fr.documents.tooLarge);
		if (!(UPLOAD_MIME_TYPES as readonly string[]).includes(file.type)) return void (message = fr.documents.badType);
		busy = leaseId;
		try {
			const created = await organizations.call<{ document: DocumentView; upload: { url: string } }>('POST', '/documents', {
				id: newId(),
				type: 'signed_lease_scan',
				leaseId,
				fileName: file.name,
				mimeType: file.type,
				byteSize: file.size,
				restriction: null
			});
			const put = await fetch(created.upload.url, { method: 'PUT', body: file, headers: { 'content-type': file.type } });
			if (!put.ok) throw new Error(fr.documents.badType);
			const done = await organizations.call<DocumentView>('POST', `/documents/${created.document.id}/uploaded`);
			if (done.status === 'rejected') {
				message = fr.documents.badType;
			} else {
				deposited = [...deposited, leaseId];
				info = t.deposited;
			}
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = null;
		}
	}
</script>

<PageHeader title={t.title} subtitle={t.subtitle} back="app/import" backLabel={fr.imports.back} />

<main class="page space-y-4 pt-3 pb-10" data-testid="contrats-a-deposer">
	<FeatureGate key="imports.excel">
		{#if !allowed}
			<FormAlert message={fr.imports.noAccess} />
		{:else}
			{#if !sync.online}<FormAlert message={fr.documents.online} tone="info" />{/if}
			<FormAlert {message} />
			<FormAlert message={info} tone="info" />
			{#if !items.length}
				<p class="text-base text-muted-foreground">{t.none}</p>
			{:else}
				<p class="text-base font-medium" data-testid="nombre-a-deposer">{t.count(items.length)}</p>
				<ul class="grid gap-3 lg:grid-cols-2">
					{#each items as l (l.id)}
						<li class="min-w-0 space-y-3 rounded-2xl border bg-card p-4" data-testid="contrat-a-deposer">
							<div class="flex min-w-0 flex-wrap items-start justify-between gap-2">
								<div class="min-w-0 space-y-0.5">
									<p class="font-semibold break-words" data-testid="unite-a-deposer">{l.unitLabel}</p>
									<p class="text-base break-words">{l.tenantName}</p>
									<p class="text-sm text-muted-foreground">{t.since(formatDate(l.startsOn))}</p>
								</div>
								<Badge variant={l.status === 'signed' ? 'info' : 'warning'}>{fr.leases.status[l.status]}</Badge>
							</div>
							<div class="space-y-1">
								<label for="scan-{l.id}" class="block font-medium">{t.file}</label>
								<input
									id="scan-{l.id}"
									type="file"
									accept={UPLOAD_MIME_TYPES.join(',')}
									class="block w-full min-w-0 text-base file:mr-3 file:min-h-11 file:rounded-lg file:border-0 file:bg-secondary file:px-4 file:font-medium"
									onchange={(e) => pick(l.id, e)}
									data-testid="scan-fichier"
								/>
							</div>
							<div class="flex flex-wrap gap-2">
								<Button onclick={() => deposit(l.id)} disabled={!files[l.id] || busy !== null || !sync.online} data-testid="deposer-scan"
									><FileUp aria-hidden="true" />{t.deposit}</Button
								>
								<Button variant="outline" href={resolve('/app/baux/[id]', { id: l.id })}>{t.openLease}</Button>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
		{#snippet fallback()}<FormAlert message={fr.imports.unavailable} tone="info" />{/snippet}
	</FeatureGate>
</main>
