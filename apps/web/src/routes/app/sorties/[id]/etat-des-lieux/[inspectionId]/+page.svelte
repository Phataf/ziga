<script lang="ts">
	/**
	 * État des lieux guidé, pièce par pièce (lot 10 bis, étape 4 ; article 9) : utilisable hors ligne par l'agent de
	 * terrain sur ses unités. Chaque élément s'écrit sur l'appareil dès qu'il est complet — texte précis (« bon état »
	 * seul refusé, même règle que le serveur) et constat à la sortie — puis part par la synchronisation. Photos prises sur
	 * place, gardées sur l'appareil et envoyées dès la connexion. Signature : la case cochée par chaque partie sur cet
	 * appareil (« Case cochée par … le … sur l'appareil de … »), ou le scan signé à la main ; jamais une signature
	 * électronique. Signé des deux parties, il est figé ; une contestation s'enregistre, la plateforme n'arbitre pas.
	 */
	import { onMount } from 'svelte';
	import { Camera, ChevronLeft, ChevronRight, CircleAlert, CircleCheck, Plus, Trash2 } from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { formatDate } from '@ziga/shared/dates';
	import { INSPECTION_FINDINGS, type InspectionFinding } from '@ziga/shared/deposit-settlement';
	import { disputeSchema, disputeOutcomeSchema } from '@ziga/shared/exit-schemas';
	import { newId } from '@ziga/shared/ids';
	import { can } from '@ziga/shared/permissions';
	import {
		DEFAULT_INSPECTION_ELEMENTS,
		DEFAULT_INSPECTION_ROOMS,
		inspectionItemBlocker,
		normalizeDescription,
		tenantRepairHints
	} from '@ziga/shared/tenant-exit';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import ReceiptPicker from '#lib/components/collections/ReceiptPicker.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { auth } from '#lib/auth/auth.svelte.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { assemblePdf, uploadExitDocument } from '#lib/exit/documents.ts';
	import { inspectionPhotoQueue } from '#lib/exit/photo-queue.svelte.ts';
	import {
		elementLabel,
		roomTemplate,
		signatureView,
		toInspection,
		toItem,
		type LocalInspection,
		type LocalItem
	} from '#lib/exit/views.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { toTenant } from '#lib/leases/views.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { compressPhoto } from '#lib/properties/photos.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';
	import { addInspectionItems, checkInspection, deleteInspectionItem, updateInspectionItem } from '#lib/sync/writes.ts';

	type Row = Record<string, unknown>;
	const t = fr.exit.inspection;
	const leaseId = $derived(page.params.id ?? '');
	const inspectionId = $derived(page.params.inspectionId ?? '');
	const role = $derived(organizations.active?.role);
	const org = $derived(organizations.activeId);

	let inspection = $state<LocalInspection | null>(null);
	let allItems = $state<LocalItem[]>([]);
	let entryInspection = $state<LocalInspection | null>(null);
	let documents = $state<Row[]>([]);
	let members = $state<Row[]>([]);
	let tenantId = $state<string | null>(null);
	let tenantName = $state('');
	let loaded = $state(false);
	let message = $state<string | null>(null);
	let info = $state<string | null>(null);

	onMount(() => {
		const o = organizations.activeId;
		const onError = (error: Error) => (message = messageOf(error));
		const stops = [
			sync.watch<Row>(
				LOCAL_QUERIES.inspection,
				[o, inspectionId],
				(r) => ((inspection = r[0] ? toInspection(r[0]) : null), (loaded = true)),
				onError
			),
			sync.watch<Row>(LOCAL_QUERIES.leaseInspectionItems, [o, leaseId], (r) => (allItems = r.map(toItem)), onError),
			sync.watch<Row>(
				LOCAL_QUERIES.leaseInspections,
				[o, leaseId],
				(r) => (entryInspection = r.map(toInspection).find((i) => i.type === 'entry') ?? null),
				onError
			),
			sync.watch<Row>(LOCAL_QUERIES.inspectionDocuments, [o, inspectionId], (r) => (documents = r), onError),
			sync.watch<Row>(LOCAL_QUERIES.allMembers, [o], (r) => (members = r), onError),
			sync.watch<Row>(LOCAL_QUERIES.lease, [o, leaseId], (r) => (tenantId = r[0] ? String(r[0].tenant_id) : null), onError)
		];
		void inspectionPhotoQueue.start();
		return () => stops.forEach((s) => s());
	});

	$effect(() => {
		const o = organizations.activeId;
		if (!tenantId) return;
		return sync.watch<Row>(LOCAL_QUERIES.tenant, [o, tenantId], (x) => (tenantName = x[0] ? toTenant(x[0]).fullName : ''));
	});

	const type = $derived(inspection?.type ?? 'exit');
	const editable = $derived(inspection?.status === 'draft' && can(role, 'inspection.create'));
	const items = $derived(allItems.filter((i) => i.inspectionId === inspectionId));
	const entryItems = $derived(entryInspection ? allItems.filter((i) => i.inspectionId === entryInspection!.id) : []);
	const key = (room: string, element: string) => `${normalizeDescription(room)}|${normalizeDescription(element)}`;
	const entryByKey = $derived(new Map(entryItems.map((e) => [key(e.room, e.element), e])));
	const entryById = $derived(new Map(entryItems.map((e) => [e.id, e])));

	// ---- brouillons : un élément n'est écrit sur l'appareil que complet (jamais refusé par le serveur pour un texte vide)
	interface Draft {
		id: string;
		room: string;
		element: string;
		position: number;
		description: string;
		finding: InspectionFinding | null;
		entryItemId: string | null;
	}
	let drafts = $state<Draft[]>([]);
	/** Texte en cours de saisie d'un élément déjà enregistré. */
	let edits = $state<Record<string, string>>({});
	let roomIndex = $state(0);

	const cards = $derived<(Draft & { saved: boolean })[]>([
		...items.map((i) => ({ ...i, saved: true })),
		...drafts.filter((d) => !items.some((i) => i.id === d.id)).map((d) => ({ ...d, saved: false }))
	]);
	const rooms = $derived.by(() => {
		const out: string[] = [];
		for (const c of [...cards].sort((a, b) => a.position - b.position)) if (!out.includes(c.room)) out.push(c.room);
		return out;
	});
	const room = $derived(rooms[Math.min(roomIndex, Math.max(rooms.length - 1, 0))] ?? null);
	const roomCards = $derived(cards.filter((c) => c.room === room).sort((a, b) => a.position - b.position));
	const nextPosition = $derived(cards.reduce((m, c) => Math.max(m, c.position + 1), 0));
	const description = (c: Draft & { saved: boolean }) => (c.saved ? (edits[c.id] ?? c.description) : c.description);
	const blockerOf = (c: Draft & { saved: boolean }) => inspectionItemBlocker(type, { description: description(c), finding: c.finding });
	const remaining = $derived(cards.filter((c) => !c.saved || blockerOf(c) !== null).length);

	async function db() {
		return sync.db ?? (await sync.start());
	}

	/** Écrit l'élément dès qu'il est complet ; un élément déjà écrit ne part que pour les champs modifiés. */
	async function persist(c: Draft & { saved: boolean }) {
		message = null;
		const text = description(c).trim();
		if (inspectionItemBlocker(type, { description: text, finding: c.finding })) return;
		try {
			if (c.saved) {
				const item = items.find((i) => i.id === c.id);
				if (!item) return;
				const changes: Record<string, unknown> = {};
				if (text !== item.description) changes.description = text;
				if (c.finding !== item.finding) changes.finding = c.finding;
				if (Object.keys(changes).length) await updateInspectionItem(await db(), org!, c.id, changes);
				delete edits[c.id];
			} else {
				await addInspectionItems(await db(), org!, inspectionId, [
					{
						id: c.id,
						room: c.room,
						element: c.element,
						position: c.position,
						description: text,
						finding: c.finding,
						entryItemId: c.entryItemId
					}
				]);
				drafts = drafts.filter((d) => d.id !== c.id);
			}
		} catch (error) {
			message = messageOf(error);
		}
	}

	function setFinding(c: Draft & { saved: boolean }, finding: InspectionFinding) {
		if (c.saved) void persist({ ...c, finding, description: description(c) });
		else {
			drafts = drafts.map((d) => (d.id === c.id ? { ...d, finding } : d));
			void persist({ ...c, finding });
		}
	}

	function setText(c: Draft & { saved: boolean }, text: string) {
		if (c.saved) edits[c.id] = text;
		else drafts = drafts.map((d) => (d.id === c.id ? { ...d, description: text } : d));
	}

	async function remove(c: Draft & { saved: boolean }) {
		if (!c.saved) return void (drafts = drafts.filter((d) => d.id !== c.id));
		try {
			await deleteInspectionItem(await db(), org!, c.id);
		} catch (error) {
			message = messageOf(error);
		}
	}

	// ---- pièces et éléments
	let newRoom = $state<string>(DEFAULT_INSPECTION_ROOMS[0]);
	let customRoom = $state('');
	let newElement = $state<string>(DEFAULT_INSPECTION_ELEMENTS[0].key);

	function addRoom(event: SubmitEvent) {
		event.preventDefault();
		const name = (newRoom === '__autre' ? customRoom : newRoom).trim();
		if (!name) return;
		// L'état des lieux d'entrée de la même pièce donne les éléments à revoir ; sinon, ceux proposés pour la pièce.
		const fromEntry = entryItems.filter((e) => normalizeDescription(e.room) === normalizeDescription(name));
		const elements = fromEntry.length
			? fromEntry.map((e) => ({ element: e.element, entryItemId: e.id }))
			: roomTemplate(name).map((e) => ({ element: e, entryItemId: null }));
		const start = nextPosition;
		drafts = [
			...drafts,
			...elements.map((e, i) => ({
				id: newId(),
				room: name,
				element: e.element,
				position: start + i,
				description: '',
				finding: null,
				entryItemId: e.entryItemId ?? entryByKey.get(key(name, e.element))?.id ?? null
			}))
		];
		customRoom = '';
		roomIndex = rooms.includes(name) ? rooms.indexOf(name) : rooms.length;
	}

	function addElement() {
		if (!room) return;
		drafts = [
			...drafts,
			{
				id: newId(),
				room,
				element: newElement,
				position: nextPosition,
				description: '',
				finding: null,
				entryItemId: entryByKey.get(key(room, newElement))?.id ?? null
			}
		];
	}

	// ---- photos (file de l'appareil)
	const sentPhotos = (itemId: string) => documents.filter((d) => d.inspection_item_id === itemId && d.type === 'inspection_photo').length;

	async function takePhoto(c: Draft & { saved: boolean }, event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const files = Array.from(input.files ?? []);
		input.value = '';
		message = null;
		try {
			for (const file of files) {
				const blob = await compressPhoto(file);
				await inspectionPhotoQueue.add({
					id: newId(),
					organizationId: org!,
					inspectionId,
					inspectionItemId: c.id,
					type: 'inspection_photo',
					blob,
					fileName: `${c.element}.jpg`,
					mimeType: 'image/jpeg'
				});
			}
		} catch (error) {
			message = fr.expenses.receipt.errors[(error as { code?: string }).code ?? ''] ?? messageOf(error);
		}
	}

	// ---- signatures
	const names = $derived(new Map(members.map((m) => [String(m.user_id), String(m.display_name ?? '')])));
	const scanDoc = $derived(documents.find((d) => d.type === 'inspection_scan' && d.id === inspection?.scanDocumentId));
	const signatures = $derived(
		inspection
			? signatureView(inspection, {
					names,
					tenantName: tenantName || fr.exit.agreements.parties.tenant!,
					me: { id: auth.user?.id ?? '', name: auth.user?.name ?? '' },
					scanUploader: scanDoc ? { name: names.get(String(scanDoc.uploaded_by)) ?? '—', at: String(scanDoc.created_at ?? '') } : undefined
				})
			: null
	);
	const canSign = $derived(can(role, 'inspection.sign') && inspection?.status === 'draft' && remaining === 0 && items.length > 0);
	const queuedScan = $derived(inspectionPhotoQueue.scanOf(inspectionId));

	async function check(party: 'organization' | 'tenant') {
		message = null;
		try {
			await checkInspection(await db(), org!, inspectionId, party);
		} catch (error) {
			message = messageOf(error);
		}
	}

	let scanFiles = $state<File[]>([]);
	async function depositScan() {
		message = null;
		if (!scanFiles.length) return;
		try {
			const blob = await assemblePdf(scanFiles, 'État des lieux signé');
			await inspectionPhotoQueue.add({
				id: newId(),
				organizationId: org!,
				inspectionId,
				inspectionItemId: null,
				type: 'inspection_scan',
				blob,
				fileName: 'etat-des-lieux-signe.pdf',
				mimeType: 'application/pdf'
			});
			scanFiles = [];
			info = fr.exit.savedLocal;
		} catch (error) {
			message = messageOf(error);
		}
	}

	// ---- contestation (en ligne)
	let disputeParty = $state<'tenant' | 'organization'>('tenant');
	let observations = $state('');
	let outcome = $state<'amicable_agreement' | 'court_decision'>('amicable_agreement');
	let outcomeFiles = $state<File[]>([]);
	let busy = $state(false);

	async function dispute(event: SubmitEvent) {
		event.preventDefault();
		message = null;
		const parsed = disputeSchema.safeParse({ party: disputeParty, observations });
		if (!parsed.success) return void (message = parsed.error.issues[0]!.message);
		busy = true;
		try {
			await organizations.call('POST', `/inspections/${inspectionId}/dispute`, parsed.data);
			observations = '';
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}

	async function resolveDispute(event: SubmitEvent) {
		event.preventDefault();
		message = null;
		if (!outcomeFiles.length) return void (message = fr.exit.inspection.outcomeDocument);
		busy = true;
		try {
			const documentId = await uploadExitDocument('settlement_outcome', { leaseId }, outcomeFiles, 'Issue de la contestation');
			const parsed = disputeOutcomeSchema.parse({ outcome, documentId });
			await organizations.call('POST', `/inspections/${inspectionId}/resolve`, parsed);
			outcomeFiles = [];
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}

	const select = 'min-h-11 w-full rounded-lg border bg-background px-3 text-base';
	const fileLabel =
		'inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border-2 border-input px-4 font-medium focus-within:outline-2 focus-within:outline-ring';
</script>

{#snippet card(c: Draft & { saved: boolean })}
	{@const blocker = blockerOf(c)}
	{@const entry = c.entryItemId ? entryById.get(c.entryItemId) : entryByKey.get(key(c.room, c.element))}
	{@const queued = inspectionPhotoQueue.of(c.id)}
	{@const sent = sentPhotos(c.id)}
	<article class="space-y-3 rounded-xl border bg-card p-4" data-testid="element" data-element={c.element}>
		<div class="flex flex-wrap items-start justify-between gap-2">
			<div class="min-w-0">
				<h3 class="font-semibold">{elementLabel(c.element)}</h3>
				<p class="text-sm break-words text-muted-foreground">{entry ? t.atEntry(entry.description) : t.noEntry}</p>
			</div>
			{#if c.saved && !blocker}<Badge variant="success"><CircleCheck class="size-4" aria-hidden="true" />{fr.exit.saved}</Badge>{/if}
		</div>
		{#if editable}
			{#if type === 'exit'}
				<fieldset class="space-y-2">
					<legend class="text-base font-medium">{t.finding} — {elementLabel(c.element)}</legend>
					<div class="grid gap-2 sm:grid-cols-3">
						{#each INSPECTION_FINDINGS as f (f)}
							<label class="flex min-h-11 items-center gap-3 rounded-lg border-2 bg-card px-3 py-2 has-checked:border-primary">
								<input
									type="radio"
									name="constat-{c.id}"
									value={f}
									checked={c.finding === f}
									onchange={() => setFinding(c, f)}
									class="size-5 shrink-0"
									data-testid="constat-{f}"
								/>{t.findings[f]}
							</label>
						{/each}
					</div>
				</fieldset>
			{/if}
			<div class="space-y-1">
				<label for="desc-{c.id}" class="text-base font-medium">{t.description}</label>
				<textarea
					id="desc-{c.id}"
					class="min-h-20 w-full rounded-lg border bg-background p-3 text-base"
					maxlength={1000}
					value={description(c)}
					oninput={(e) => setText(c, (e.currentTarget as HTMLTextAreaElement).value)}
					onblur={() => persist({ ...c, description: description(c) })}
					data-testid="description"></textarea>
				<p class="text-sm text-muted-foreground">{t.descriptionHint}</p>
			</div>
			{#if blocker && description(c).trim()}
				<p class="flex items-start gap-2 text-base text-destructive" role="alert" data-testid="refus-element">
					<CircleAlert class="mt-0.5 size-5 shrink-0" aria-hidden="true" />{t.blockers[blocker]}
				</p>
			{/if}
			{#if c.finding === 'tenant_damage'}
				{@const hints = tenantRepairHints(c.element)}
				{#if hints.length}<p class="text-sm text-muted-foreground">{t.repairHints(hints.map((h) => h.label).join(', '))}</p>{/if}
			{:else if c.finding}
				<p class="text-sm text-muted-foreground">{t.findingHint}</p>
			{/if}
			<div class="flex flex-wrap items-center gap-2">
				{#if c.saved}
					<label class={fileLabel}>
						<Camera class="size-5" aria-hidden="true" />{t.takePhoto}
						<input
							type="file"
							accept="image/*"
							capture="environment"
							multiple
							class="sr-only"
							onchange={(e) => takePhoto(c, e)}
							data-testid="photo"
						/>
					</label>
				{/if}
				<Button variant="ghost" onclick={() => remove(c)}><Trash2 class="size-5" aria-hidden="true" />{t.removeElement}</Button>
			</div>
		{:else}
			{#if c.finding}<p><Badge variant={c.finding === 'tenant_damage' ? 'warning' : 'secondary'}>{t.findings[c.finding]}</Badge></p>{/if}
			<p class="text-base break-words">{c.description}</p>
		{/if}
		{#if queued.length || sent}
			<div class="space-y-1" data-testid="photos-element">
				<p class="text-sm text-muted-foreground">
					{t.photos} · {t.photoCount(queued.length + sent)}{sent ? ` · ${t.photoSent(sent)}` : ''}
				</p>
				<ul class="flex flex-wrap gap-2">
					{#each queued as q (q.id)}
						<li class="space-y-1">
							{#if inspectionPhotoQueue.previews[q.id]}
								<img
									src={inspectionPhotoQueue.previews[q.id]}
									alt="{t.photos} — {elementLabel(c.element)}"
									class="size-20 rounded-lg object-cover"
								/>
							{/if}
							{#if q.error}
								<p class="max-w-40 text-sm text-destructive">{t.photoRefused(q.error)}</p>
								<Button variant="ghost" onclick={() => inspectionPhotoQueue.remove(q.id)}>{t.photoDiscard}</Button>
							{:else}
								<p class="text-sm text-muted-foreground" data-testid="photo-en-attente">
									{inspectionPhotoQueue.sending === q.id ? t.photoSending : t.photoQueued}
								</p>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	</article>
{/snippet}

<PageHeader
	title={type === 'entry' ? t.titleEntry : t.titleExit}
	subtitle={inspection ? `${tenantName} · ${formatDate(inspection.inspectedOn)}` : undefined}
	back="app/sorties"
	backLabel={fr.exit.back}
/>

<main class="page space-y-4 pt-3 pb-10" data-testid="etat-des-lieux">
	<FormAlert {message} />
	<FormAlert message={info} tone="info" />
	{#if loaded && !inspection}
		<FormAlert message={fr.exit.notFound} />
	{:else if inspection}
		{#if rooms.length}
			<div class="flex gap-2 overflow-x-auto pb-1" role="group" aria-label={t.rooms}>
				{#each rooms as r, i (r)}
					<button
						type="button"
						class="min-h-11 shrink-0 rounded-full border-2 px-4 font-medium {r === room
							? 'border-primary bg-primary text-primary-foreground'
							: 'border-input bg-card hover:bg-accent'}"
						aria-pressed={r === room}
						onclick={() => (roomIndex = i)}
						data-testid="piece-{i}">{r}</button
					>
				{/each}
			</div>
		{/if}

		{#if room}
			<section class="space-y-3" aria-labelledby="titre-piece" data-testid="piece">
				<h2 id="titre-piece" class="text-lg font-semibold">{t.room(rooms.indexOf(room) + 1, rooms.length, room)}</h2>
				<div class="grid gap-3 xl:grid-cols-2">
					{#each roomCards as c (c.id)}{@render card(c)}{/each}
				</div>
				{#if editable}
					<div class="flex flex-wrap items-end gap-2">
						<div class="min-w-48 flex-1 space-y-1">
							<label for="nouvel-element" class="text-base font-medium">{t.elementName}</label>
							<select id="nouvel-element" class={select} bind:value={newElement}>
								{#each DEFAULT_INSPECTION_ELEMENTS as e (e.key)}<option value={e.key}>{e.label}</option>{/each}
							</select>
						</div>
						<Button variant="outline" onclick={addElement}><Plus class="size-5" aria-hidden="true" />{t.addElement}</Button>
					</div>
				{/if}
				<div class="flex flex-wrap gap-2">
					<Button variant="outline" disabled={rooms.indexOf(room) === 0} onclick={() => (roomIndex = rooms.indexOf(room) - 1)}
						><ChevronLeft class="size-5" aria-hidden="true" />{t.previousRoom}</Button
					>
					<Button
						variant="outline"
						disabled={rooms.indexOf(room) === rooms.length - 1}
						onclick={() => (roomIndex = rooms.indexOf(room) + 1)}
						data-testid="piece-suivante">{t.nextRoom}<ChevronRight class="size-5" aria-hidden="true" /></Button
					>
				</div>
			</section>
		{/if}

		{#if editable}
			<form class="flex flex-wrap items-end gap-2 rounded-xl border bg-card p-4" onsubmit={addRoom} data-testid="ajouter-piece">
				<div class="min-w-48 flex-1 space-y-1">
					<label for="nouvelle-piece" class="text-base font-medium">{t.roomName}</label>
					<select id="nouvelle-piece" class={select} bind:value={newRoom} data-testid="choix-piece">
						{#each DEFAULT_INSPECTION_ROOMS as r (r)}<option value={r}>{r}</option>{/each}
						<option value="__autre">{fr.exit.notice.deliveryModes.other}</option>
					</select>
				</div>
				{#if newRoom === '__autre'}
					<div class="min-w-48 flex-1 space-y-1">
						<label for="piece-libre" class="text-base font-medium">{t.roomName}</label>
						<Input id="piece-libre" bind:value={customRoom} maxlength={80} />
					</div>
				{/if}
				<Button type="submit" data-testid="ajouter-piece-valider"><Plus class="size-5" aria-hidden="true" />{t.addRoomSubmit}</Button>
			</form>
		{/if}

		<section class="space-y-3 rounded-xl border bg-card p-4" aria-labelledby="titre-signatures" data-testid="signatures">
			<h2 id="titre-signatures" class="text-lg font-semibold">{t.signatures}</h2>
			{#if inspection.status === 'draft'}
				<p class="text-base text-muted-foreground">{t.signHint}</p>
				{#if remaining > 0}<p class="text-base font-medium" data-testid="reste-a-completer">{t.remaining(remaining)}</p>{/if}
			{/if}
			<ul class="space-y-2">
				{#each [{ party: 'organization' as const, label: t.checkOrganization(organizations.active?.name ?? ''), done: signatures?.organization }, { party: 'tenant' as const, label: t.checkTenant(tenantName), done: signatures?.tenant }] as s (s.party)}
					<li class="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3" data-testid="case-{s.party}">
						<span class="min-w-0 font-medium">{s.label}</span>
						{#if s.done}
							<span class="text-base break-words" data-testid="libelle-case-{s.party}">{s.done}</span>
						{:else if canSign}
							<Button onclick={() => check(s.party)} data-testid="cocher-{s.party}">{t.check}</Button>
						{/if}
					</li>
				{/each}
			</ul>
			{#if signatures?.scan}<p class="text-base" data-testid="libelle-scan">{signatures.scan}</p>{/if}
			{#if inspection.status === 'draft' && signatures?.complete}<p class="text-base">{t.waitingServer}</p>{/if}
			{#if inspection.status === 'signed_both'}<p class="flex items-center gap-2 text-base font-medium" data-testid="edl-fige">
					<CircleCheck class="size-5 text-primary" aria-hidden="true" />{t.signed}
				</p>{/if}
			{#if canSign && !inspection.scanDocumentId}
				{#if queuedScan}
					<p class="text-base text-muted-foreground">{queuedScan.error ? t.photoRefused(queuedScan.error) : t.scanQueued}</p>
				{:else}
					<ReceiptPicker bind:files={scanFiles} title={t.scan} hint={t.signHint} testid="scan-edl" />
					{#if scanFiles.length}<Button variant="outline" onclick={depositScan} data-testid="deposer-scan">{t.scan}</Button>{/if}
				{/if}
			{/if}
		</section>

		{#if inspection.status !== 'draft' && can(role, 'inspection.sign')}
			<section class="space-y-3 rounded-xl border bg-card p-4" aria-labelledby="titre-contestation" data-testid="contestation-edl">
				<h2 id="titre-contestation" class="text-lg font-semibold">{t.dispute}</h2>
				{#if inspection.status === 'disputed'}
					<p class="text-base">{t.disputed}</p>
					{#if inspection.tenantObservations}<p class="text-base break-words">
							{fr.exit.agreements.parties.tenant} : {inspection.tenantObservations}
						</p>{/if}
					{#if inspection.organizationObservations}<p class="text-base break-words">
							{fr.exit.agreements.parties.organization} : {inspection.organizationObservations}
						</p>{/if}
					{#if inspection.disputeOutcome}
						<Badge variant="info">{t.outcomes[inspection.disputeOutcome]}</Badge>
					{:else if can(role, 'deposit.settle')}
						<form class="space-y-3" onsubmit={resolveDispute}>
							<label for="issue-edl" class="text-base font-medium">{t.outcome}</label>
							<select id="issue-edl" class={select} bind:value={outcome}>
								<option value="amicable_agreement">{t.outcomes.amicable_agreement}</option>
								<option value="court_decision">{t.outcomes.court_decision}</option>
							</select>
							<ReceiptPicker bind:files={outcomeFiles} title={t.outcomeDocument} hint={t.outcomeDocument} testid="issue-document" />
							<Button type="submit" disabled={busy || !sync.online}>{t.outcomeSubmit}</Button>
						</form>
					{/if}
				{/if}
				<form class="space-y-3" onsubmit={dispute}>
					<label for="partie-contestation" class="text-base font-medium">{t.disputeParty}</label>
					<select id="partie-contestation" class={select} bind:value={disputeParty}>
						<option value="tenant">{fr.exit.notice.origins.tenant}</option>
						<option value="organization">{organizations.active?.name}</option>
					</select>
					<label for="observations-edl" class="text-base font-medium">{t.observations}</label>
					<textarea
						id="observations-edl"
						class="min-h-20 w-full rounded-lg border bg-background p-3 text-base"
						maxlength={2000}
						bind:value={observations}></textarea>
					<Button type="submit" variant="outline" disabled={busy || !sync.online}>{t.disputeSubmit}</Button>
					{#if !sync.online}<p class="text-sm text-muted-foreground">{fr.exit.onlineOnly}</p>{/if}
				</form>
			</section>
		{/if}

		<Button variant="outline" href={resolve('/app/sorties/[id]', { id: leaseId })} data-testid="terminer-edl">{t.done}</Button>
	{/if}
</main>
