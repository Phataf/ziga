<script lang="ts">
	/**
	 * Fiche d'un bien (lot 07) : lue dans la base de l'appareil. Une pastille par dimension du statut de chaque unité
	 * (D14) ; changement de l'état technique (motif hors « prête »), affectation à un agent de terrain, fiche activée ou
	 * archivée ; galerie du bien et de chaque unité ; documents privés (direction et gestion, en ligne). L'agent de
	 * terrain ne voit que ses unités affectées et n'y change que l'état technique et les photos.
	 */
	import { onMount } from 'svelte';
	import { Archive, CheckCircle2, MapPin, Pencil, Wrench } from '@lucide/svelte';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { formatDate } from '@ziga/shared/dates';
	import type { DocumentView } from '@ziga/shared/documents';
	import { formatFcfa } from '@ziga/shared/money';
	import type { OwnerView } from '@ziga/shared/owners';
	import { can } from '@ziga/shared/permissions';
	import {
		technicalStatusSchema,
		TECHNICAL_STATUSES,
		type MediaView,
		type PropertyView,
		type TechnicalStatus,
		type UnitView
	} from '@ziga/shared/properties';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import DocumentsSection from '#lib/components/properties/DocumentsSection.svelte';
	import PhotoGallery from '#lib/components/properties/PhotoGallery.svelte';
	import StatusBadge from '#lib/components/properties/StatusBadge.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import Sheet from '#lib/components/ui/sheet/Sheet.svelte';
	import { messageOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { toOwner } from '#lib/owners/views.ts';
	import { galleryOf, toDocument, toMedia, toProperty, toUnit, unitDimensions } from '#lib/properties/views.ts';
	import { photoQueue } from '#lib/properties/photo-queue.svelte.ts';
	import { GEOGRAPHY_QUERIES, LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';
	import { assignUnit, setRecordStatus, setTechnicalStatus } from '#lib/sync/writes.ts';

	const t = fr.properties;
	const id = $derived(page.params.id ?? '');
	const role = $derived(organizations.active?.role);
	const landlord = $derived(organizations.active?.type === 'landlord');
	const canManage = $derived(can(role, 'property.manage'));
	const canAssign = $derived(can(role, 'unit.assign') && !landlord);
	const canStatus = $derived(can(role, 'unit.status'));
	const canPhotos = $derived(can(role, 'photo.upload'));
	const canDocuments = $derived(can(role, 'document.read'));
	const select = 'min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 text-base';

	let property = $state<PropertyView | null>(null);
	let loaded = $state(false);
	let units = $state<UnitView[]>([]);
	let media = $state<MediaView[]>([]);
	let documents = $state<DocumentView[]>([]);
	let owner = $state<OwnerView | null>(null);
	let agents = $state<{ userId: string; name: string }[]>([]);
	let neighborhood = $state('');
	let commune = $state('');
	let message = $state<string | null>(null);

	// Changement d'état technique (panneau).
	let technicalOpen = $state(false);
	let technicalUnit = $state<UnitView | null>(null);
	let technical = $state<TechnicalStatus>('ready');
	let reason = $state('');
	let expectedOn = $state('');
	let technicalErrors = $state<Record<string, string>>({});

	onMount(() => {
		const org = organizations.activeId;
		const onError = (error: Error) => (message = messageOf(error));
		void photoQueue.start();
		const stops = [
			sync.watch<Record<string, unknown>>(
				LOCAL_QUERIES.property,
				[org, id],
				(rows) => {
					property = rows[0] ? toProperty(rows[0]) : null;
					loaded = true;
				},
				onError
			),
			sync.watch<Record<string, unknown>>(LOCAL_QUERIES.propertyUnits, [org, id], (rows) => (units = rows.map(toUnit)), onError),
			sync.watch<Record<string, unknown>>(LOCAL_QUERIES.propertyMedia, [org, id], (rows) => (media = rows.map(toMedia)), onError),
			sync.watch<Record<string, unknown>>(
				LOCAL_QUERIES.fieldAgents,
				[org],
				(rows) => (agents = rows.map((r) => ({ userId: String(r.user_id), name: String(r.display_name ?? '') }))),
				onError
			)
		];
		if (can(role, 'document.read')) {
			stops.push(
				sync.watch<Record<string, unknown>>(
					LOCAL_QUERIES.propertyDocuments,
					[org, id],
					(rows) => (documents = rows.map(toDocument)),
					onError
				)
			);
		}
		return () => stops.forEach((stop) => stop());
	});

	// Propriétaire, quartier et commune du bien, relus quand le bien change.
	$effect(() => {
		const org = organizations.activeId;
		const p = property;
		if (!p) return;
		const stops = [
			sync.watch<Record<string, unknown>>(LOCAL_QUERIES.owner, [org, p.ownerId], (rows) => (owner = rows[0] ? toOwner(rows[0]) : null)),
			sync.watch<Record<string, unknown>>(GEOGRAPHY_QUERIES.neighborhoods, [], (rows) => {
				neighborhood = String(rows.find((r) => r.id === p.neighborhoodId)?.name ?? '');
			}),
			sync.watch<Record<string, unknown>>(GEOGRAPHY_QUERIES.communes, [], (rows) => {
				commune = String(rows.find((r) => r.id === p.communeId)?.name ?? '');
			})
		];
		return () => stops.forEach((stop) => stop());
	});

	async function db() {
		return sync.db ?? (await sync.start());
	}

	async function status(table: 'properties' | 'units', rowId: string, next: 'active' | 'archived') {
		message = null;
		const org = organizations.activeId;
		if (!org) return;
		if (table === 'properties' && next === 'active' && (!property?.communeId || !property.neighborhoodId)) {
			message = t.locationRequired;
			return;
		}
		try {
			await setRecordStatus(await db(), org, table, rowId, next);
		} catch (error) {
			message = messageOf(error);
		}
	}

	async function assign(unit: UnitView, agentId: string) {
		const org = organizations.activeId;
		if (org) await assignUnit(await db(), org, unit.id, agentId || null);
	}

	function openTechnical(unit: UnitView) {
		technicalUnit = unit;
		technical = unit.technicalStatus;
		reason = unit.technicalReason ?? '';
		expectedOn = unit.technicalExpectedOn ?? '';
		technicalErrors = {};
		technicalOpen = true;
	}

	async function saveTechnical(event: SubmitEvent) {
		event.preventDefault();
		const org = organizations.activeId;
		if (!org || !technicalUnit) return;
		const parsed = technicalStatusSchema.safeParse({
			technicalStatus: technical,
			reason: technical === 'ready' ? null : reason,
			expectedOn: technical === 'ready' ? null : expectedOn || null
		});
		if (!parsed.success) {
			technicalErrors = Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0] ?? ''), i.message]));
			return;
		}
		await setTechnicalStatus(await db(), org, technicalUnit.id, parsed.data);
		technicalOpen = false;
	}

	const rooms = (u: UnitView) =>
		(Object.keys(t.rooms) as (keyof typeof t.rooms)[])
			.filter((k) => u.rooms[k] > 0)
			.map((k) => `${u.rooms[k]} ${t.rooms[k].toLowerCase()}`)
			.join(', ');
</script>

<PageHeader
	title={property?.name ?? t.title}
	subtitle={property ? `${t.types[property.type]} · ${t.recordStatus[property.recordStatus]}` : undefined}
	back="app/biens"
	backLabel={t.back}
>
	{#snippet actions()}
		{#if property && canManage}
			{#if property.recordStatus === 'draft'}
				<Button variant="outline" href="{resolve('/app/biens/assistant')}?bien={property.id}&etape=2"
					><Pencil aria-hidden="true" />{t.continueWizard}</Button
				>
				<Button onclick={() => status('properties', property!.id, 'active')}><CheckCircle2 aria-hidden="true" />{t.activate}</Button>
			{:else if property.recordStatus === 'active'}
				<Button variant="outline" onclick={() => status('properties', property!.id, 'archived')}
					><Archive aria-hidden="true" />{t.archive}</Button
				>
			{:else}
				<Button variant="outline" onclick={() => status('properties', property!.id, 'active')}>{t.reactivate}</Button>
			{/if}
		{/if}
	{/snippet}
</PageHeader>

<main class="page space-y-6 pt-3 pb-10" data-testid="fiche-bien">
	<FormAlert {message} />
	{#if page.state.saved}<FormAlert message={t.saved} tone="info" />{/if}
	{#if loaded && !property}
		<FormAlert message={t.notFound} />
	{:else if property}
		<section class="space-y-2 rounded-2xl border bg-card p-4 md:p-6">
			<p class="flex items-start gap-2 text-base">
				<MapPin class="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
				<span>
					{[neighborhood, commune].filter(Boolean).join(', ') || t.locationRequired}
					{#if property.addressHint}<span class="block text-muted-foreground">{property.addressHint}</span>{/if}
				</span>
			</p>
			{#if owner && !landlord}<p class="text-base"><span class="text-muted-foreground">{t.owner} :</span> {owner.name}</p>{/if}
			{#if property.gps}
				<p class="text-sm text-muted-foreground">
					{t.gps} : {property.gps.lat.toFixed(5)}, {property.gps.lng.toFixed(5)}{property.gps.accuracyM !== null
						? ` · ${t.gpsAccuracy(property.gps.accuracyM)}`
						: ''}
				</p>
			{/if}
			{#if property.declaredLandDocuments.length}
				<p class="text-base">
					<span class="text-muted-foreground">{t.declaredDocuments} :</span>
					{property.declaredLandDocuments.map((d) => t.landDocuments[d]).join(', ')}
				</p>
			{/if}
		</section>

		<section class="space-y-3">
			<h2 class="text-lg font-semibold">{t.units}</h2>
			{#if !units.length}
				<p class="text-base text-muted-foreground">{property.type === 'land' ? t.landNoUnit : t.noUnit}</p>
			{/if}
			<ul class="space-y-4">
				{#each units as u (u.id)}
					<li class="space-y-4 rounded-2xl border bg-card p-4 md:p-6" data-testid="unite">
						<div class="flex flex-wrap items-start justify-between gap-2">
							<div class="min-w-0">
								<h3 class="text-lg font-semibold break-words">{u.label}</h3>
								<p class="text-base text-muted-foreground">
									{t.unitTypes[u.type]}{rooms(u) ? ` · ${rooms(u)}` : ''}{u.rent !== null ? ` · ${formatFcfa(u.rent)}` : ''}
								</p>
								{#if u.technicalReason}
									<p class="text-sm text-muted-foreground">
										{u.technicalReason}{u.technicalExpectedOn ? ` · ${formatDate(u.technicalExpectedOn)}` : ''}
									</p>
								{/if}
							</div>
							<div class="flex flex-wrap gap-2">
								{#if canStatus}
									<Button variant="outline" onclick={() => openTechnical(u)}><Wrench aria-hidden="true" />{t.changeTechnical}</Button>
								{/if}
								{#if canManage}
									{#if u.recordStatus !== 'active'}
										<Button variant="outline" onclick={() => status('units', u.id, 'active')}
											>{u.recordStatus === 'archived' ? t.reactivate : t.activate}</Button
										>
									{:else}
										<Button variant="ghost" onclick={() => status('units', u.id, 'archived')}
											><Archive aria-hidden="true" />{t.archive}</Button
										>
									{/if}
								{/if}
							</div>
						</div>
						<div class="flex flex-wrap gap-2" data-testid="dimensions">
							{#each unitDimensions(u) as d (d.key)}<StatusBadge prefix={d.label} label={d.value} tone={d.tone} />{/each}
						</div>
						{#if canAssign}
							<div class="max-w-sm space-y-1">
								<label for="agent-{u.id}" class="block font-medium">{t.assign}</label>
								<select
									id="agent-{u.id}"
									class={select}
									value={u.assignedAgentId ?? ''}
									onchange={(e) => assign(u, (e.currentTarget as HTMLSelectElement).value)}
								>
									<option value="">{t.assignNone}</option>
									{#each agents as a (a.userId)}<option value={a.userId}>{a.name}</option>{/each}
								</select>
								<p class="text-sm text-muted-foreground">{t.assignHint}</p>
							</div>
						{/if}
						<PhotoGallery
							propertyId={property.id}
							unitId={u.id}
							label={u.label}
							gallery={galleryOf(media, property.id, u.id)}
							canEdit={canPhotos}
							testid="galerie-unite"
						/>
					</li>
				{/each}
			</ul>
		</section>

		{#if canManage}
			<section class="rounded-2xl border bg-card p-4 md:p-6">
				<PhotoGallery
					propertyId={property.id}
					label={fr.photos.propertyPhotos}
					gallery={galleryOf(media, property.id, null)}
					canEdit={canPhotos}
					testid="galerie-bien"
				/>
			</section>
		{/if}

		{#if canDocuments}
			<DocumentsSection propertyId={property.id} ownerId={property.ownerId} {documents} />
		{/if}
	{/if}
</main>

<Sheet bind:open={technicalOpen} labelledby="titre-etat-technique">
	<form class="space-y-4 p-4" onsubmit={saveTechnical} novalidate data-testid="etat-technique">
		<h2 id="titre-etat-technique" class="text-lg font-semibold">{t.changeTechnical}{technicalUnit ? ` · ${technicalUnit.label}` : ''}</h2>
		<div class="space-y-1">
			<label for="etat" class="block font-medium">{t.technicalLabel}</label>
			<select id="etat" bind:value={technical} class={select}>
				{#each TECHNICAL_STATUSES as s (s)}<option value={s}>{t.technical[s]}</option>{/each}
			</select>
		</div>
		{#if technical !== 'ready'}
			<div class="space-y-1">
				<label for="motif" class="block font-medium">{t.technicalReason}</label>
				<Input id="motif" bind:value={reason} aria-invalid={technicalErrors.reason ? 'true' : undefined} />
				<p class="text-sm text-muted-foreground">{t.technicalReasonHint}</p>
				{#if technicalErrors.reason}<p class="text-base text-destructive">{technicalErrors.reason}</p>{/if}
			</div>
			<div class="space-y-1">
				<label for="date-prevue" class="block font-medium">{t.technicalExpected}</label>
				<Input id="date-prevue" type="date" bind:value={expectedOn} />
			</div>
		{/if}
		<Button type="submit" class="w-full">{fr.admin.save}</Button>
	</form>
</Sheet>
