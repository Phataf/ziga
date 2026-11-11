<script lang="ts">
	/**
	 * Assistant d'ajout d'un bien (lot 07, docs/UX.md §10) en cinq étapes : type et propriétaire ; localisation avec
	 * repère et point GPS ; unités ; photos ; documents privés. Le bien naît en brouillon dès la première étape et chaque
	 * étape l'enregistre sur l'appareil (hors connexion aussi) : on reprend plus tard par la fiche du bien
	 * (`?bien=<id>&etape=<n>`). Les documents privés exigent la connexion. « Terminer et activer » active le bien et ses
	 * unités ; rien n'est publié (règle 7).
	 * Téléphone : une étape par écran ; tablette et ordinateur : étapes à gauche, formulaire à droite.
	 */
	import { onMount } from 'svelte';
	import { ArrowLeft, Check, CheckCircle2, LocateFixed, Plus, Save, X } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { toIsoDate } from '@ziga/shared/dates';
	import type { DocumentView } from '@ziga/shared/documents';
	import { newId } from '@ziga/shared/ids';
	import { parseFcfa } from '@ziga/shared/money';
	import { effectiveMandateStatus, type MandateView, type OwnerView } from '@ziga/shared/owners';
	import { can } from '@ziga/shared/permissions';
	import {
		createPropertySchema,
		createUnitSchema,
		DECLARED_LAND_DOCUMENTS,
		PROPERTY_OPERATIONS,
		PROPERTY_TYPES,
		propertySchema,
		UNIT_TYPES,
		type DeclaredLandDocument,
		type MediaView,
		type PropertyOperation,
		type PropertyType,
		type PropertyView,
		type UnitType,
		type UnitView
	} from '@ziga/shared/properties';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import DocumentsSection from '#lib/components/properties/DocumentsSection.svelte';
	import PhotoGallery from '#lib/components/properties/PhotoGallery.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { toMandate, toOwner } from '#lib/owners/views.ts';
	import { photoQueue } from '#lib/properties/photo-queue.svelte.ts';
	import { galleryOf, suggestLabels, toDocument, toMedia, toProperty, toUnit } from '#lib/properties/views.ts';
	import { GEOGRAPHY_QUERIES, LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';
	import { createProperty, createUnits, saveProperty, setRecordStatus } from '#lib/sync/writes.ts';

	const t = fr.properties;
	const w = t.wizard;
	const STEPS = 5;
	const select = 'min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 text-base';
	const field = 'space-y-1';
	const labelClass = 'block font-medium';

	const role = $derived(organizations.active?.role);
	const landlord = $derived(organizations.active?.type === 'landlord');
	const allowed = $derived(can(role, 'property.manage'));
	const propertyId = $derived(page.url.searchParams.get('bien'));
	const step = $derived(propertyId ? Math.min(STEPS, Math.max(1, Number(page.url.searchParams.get('etape') ?? 2) || 2)) : 1);

	let property = $state<PropertyView | null>(null);
	let units = $state<UnitView[]>([]);
	let media = $state<MediaView[]>([]);
	let documents = $state<DocumentView[]>([]);
	let owners = $state<OwnerView[]>([]);
	let mandates = $state<MandateView[]>([]);
	let communes = $state<{ id: string; name: string }[]>([]);
	let neighborhoods = $state<{ id: string; communeId: string; name: string }[]>([]);
	let message = $state<string | null>(null);
	let errors = $state<Record<string, string>>({});
	let busy = $state(false);

	// Étape 1
	let type = $state<PropertyType>('apartment_building');
	let operation = $state<PropertyOperation>('rent');
	let name = $state('');
	let ownerId = $state('');
	let mandateId = $state('');
	// Étape 2
	let communeId = $state('');
	let neighborhoodId = $state('');
	let addressHint = $state('');
	let gps = $state<{ lat: number; lng: number; accuracyM: number | null } | null>(null);
	let gpsBusy = $state(false);
	let declared = $state<DeclaredLandDocument[]>([]);
	// Étape 3
	let unitType = $state<UnitType>('apartment');
	let count = $state<number | string>(1);
	let prefix = $state('');
	let rent = $state('');
	let bedrooms = $state<number | string>('');
	let livingRooms = $state<number | string>('');
	let unitsAdded = $state<string | null>(null);

	let filled = false;

	onMount(() => {
		const org = organizations.activeId;
		const onError = (error: Error) => (message = messageOf(error));
		void photoQueue.start();
		const stops = [
			sync.watch<Record<string, unknown>>(
				LOCAL_QUERIES.owners,
				[org],
				(rows) => {
					owners = rows.map(toOwner).filter((o) => o.status === 'active');
					// Bailleur : sa propre fiche, la seule de son organisation.
					if (landlord && !ownerId && owners[0]) ownerId = owners[0].id;
				},
				onError
			),
			sync.watch<Record<string, unknown>>(LOCAL_QUERIES.mandates, [org], (rows) => (mandates = rows.map(toMandate)), onError),
			sync.watch<Record<string, unknown>>(
				GEOGRAPHY_QUERIES.communes,
				[],
				(rows) => (communes = rows.map((r) => ({ id: String(r.id), name: String(r.name) })))
			),
			sync.watch<Record<string, unknown>>(
				GEOGRAPHY_QUERIES.neighborhoods,
				[],
				(rows) => (neighborhoods = rows.map((r) => ({ id: String(r.id), communeId: String(r.commune_id), name: String(r.name) })))
			)
		];
		return () => stops.forEach((stop) => stop());
	});

	// Le bien, ses unités, ses photos et ses documents, dès qu'il existe (brouillon).
	$effect(() => {
		const org = organizations.activeId;
		const id = propertyId;
		if (!id) return;
		const stops = [
			sync.watch<Record<string, unknown>>(LOCAL_QUERIES.property, [org, id], (rows) => {
				property = rows[0] ? toProperty(rows[0]) : null;
				if (property && !filled) fill(property);
			}),
			sync.watch<Record<string, unknown>>(LOCAL_QUERIES.propertyUnits, [org, id], (rows) => (units = rows.map(toUnit))),
			sync.watch<Record<string, unknown>>(LOCAL_QUERIES.propertyMedia, [org, id], (rows) => (media = rows.map(toMedia)))
		];
		if (can(role, 'document.read')) {
			stops.push(
				sync.watch<Record<string, unknown>>(LOCAL_QUERIES.propertyDocuments, [org, id], (rows) => (documents = rows.map(toDocument)))
			);
		}
		return () => stops.forEach((stop) => stop());
	});

	/** Reprise d'un brouillon : le formulaire repart de ce qui est enregistré. */
	function fill(p: PropertyView) {
		filled = true;
		type = p.type;
		operation = p.operation;
		name = p.name;
		ownerId = p.ownerId;
		communeId = p.communeId ?? '';
		neighborhoodId = p.neighborhoodId ?? '';
		addressHint = p.addressHint ?? '';
		gps = p.gps;
		declared = [...p.declaredLandDocuments];
	}

	const today = toIsoDate();
	const ownerMandates = $derived(mandates.filter((m) => m.ownerId === ownerId && effectiveMandateStatus(m, today) === 'active'));
	const communeNeighborhoods = $derived(neighborhoods.filter((n) => n.communeId === communeId));

	async function db() {
		return sync.db ?? (await sync.start());
	}

	function issues(error: { issues: { path: PropertyKey[]; message: string }[] }): Record<string, string> {
		const out: Record<string, string> = {};
		for (const i of error.issues) out[String(i.path[0] ?? '')] ??= i.message;
		return out;
	}

	async function go(n: number) {
		await goto(resolve(`/app/biens/assistant?bien=${propertyId}&etape=${n}`));
	}

	async function run(fn: () => Promise<void>) {
		message = null;
		busy = true;
		try {
			await fn();
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}

	/** Données complètes du bien : ce qui est enregistré, complété par la saisie. */
	function propertyData() {
		return {
			ownerId,
			type,
			operation,
			name,
			communeId: communeId || null,
			neighborhoodId: neighborhoodId || null,
			addressHint: addressHint || null,
			gps,
			declaredLandDocuments: declared,
			notes: property?.notes ?? null
		};
	}

	async function saveStep1(event: SubmitEvent) {
		event.preventDefault();
		const org = organizations.activeId;
		if (!org) return;
		if (!ownerId) return void (errors = { ownerId: t.ownerChoose });
		await run(async () => {
			if (!propertyId) {
				const parsed = createPropertySchema.safeParse({ id: newId(), ...propertyData() });
				if (!parsed.success) return void (errors = issues(parsed.error));
				errors = {};
				await createProperty(await db(), org, parsed.data, landlord ? null : mandateId || null);
				await goto(resolve(`/app/biens/assistant?bien=${parsed.data.id}&etape=2`));
				return;
			}
			const parsed = propertySchema.safeParse(propertyData());
			if (!parsed.success) return void (errors = issues(parsed.error));
			errors = {};
			await saveProperty(await db(), org, propertyId, parsed.data);
			await go(2);
		});
	}

	async function saveStep2(event: SubmitEvent) {
		event.preventDefault();
		const org = organizations.activeId;
		if (!org || !propertyId) return;
		await run(async () => {
			const parsed = propertySchema.safeParse(propertyData());
			if (!parsed.success) return void (errors = issues(parsed.error));
			errors = {};
			await saveProperty(await db(), org, propertyId, parsed.data);
			await go(3);
		});
	}

	function takeGps() {
		if (!navigator.geolocation) return void (message = t.gpsRefused);
		gpsBusy = true;
		navigator.geolocation.getCurrentPosition(
			(pos) => {
				gps = {
					lat: Math.round(pos.coords.latitude * 1e6) / 1e6,
					lng: Math.round(pos.coords.longitude * 1e6) / 1e6,
					accuracyM: Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : null
				};
				gpsBusy = false;
			},
			() => {
				message = t.gpsRefused;
				gpsBusy = false;
			},
			{ enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 }
		);
	}

	function toggleDeclared(d: DeclaredLandDocument, on: boolean) {
		if (d === 'none') declared = on ? ['none'] : [];
		else declared = on ? [...declared.filter((x) => x !== 'none' && x !== d), d] : declared.filter((x) => x !== d);
	}

	/** Champ numérique : `bind:value` d'un champ `type="number"` donne un nombre, ou une chaîne vide. */
	const int = (v: unknown) => (v === '' || v === null || v === undefined ? undefined : Number(v));

	async function addUnits(event: SubmitEvent) {
		event.preventDefault();
		const org = organizations.activeId;
		if (!org || !propertyId) return;
		await run(async () => {
			const n = Math.min(50, Math.max(1, Number(count) || 1));
			const labels = suggestLabels(
				prefix || t.unitTypes[unitType],
				n,
				units.map((u) => u.label)
			);
			const parsedRent = rent.trim() ? parseFcfa(rent) : null;
			if (rent.trim() && parsedRent === null) return void (errors = { rent: fr.fields?.amountInvalid ?? t.rent });
			const list = [];
			for (const label of labels) {
				const parsed = createUnitSchema.safeParse({
					id: newId(),
					propertyId,
					type: unitType,
					label,
					rent: parsedRent,
					rooms: { bedrooms: int(bedrooms), livingRooms: int(livingRooms) }
				});
				if (!parsed.success) return void (errors = issues(parsed.error));
				list.push(parsed.data);
			}
			errors = {};
			await createUnits(await db(), org, list);
			unitsAdded = t.unitsAdded(list.length);
		});
	}

	async function finish(activate: boolean) {
		const org = organizations.activeId;
		if (!org || !propertyId) return;
		if (activate && (!property?.communeId || !property.neighborhoodId)) return void (message = t.locationRequired);
		await run(async () => {
			const database = await db();
			if (activate) {
				await setRecordStatus(database, org, 'properties', propertyId, 'active');
				for (const u of units.filter((x) => x.recordStatus === 'draft')) await setRecordStatus(database, org, 'units', u.id, 'active');
			}
			await goto(resolve('/app/biens/[id]', { id: propertyId }), { state: { saved: true } });
		});
	}
</script>

<PageHeader
	title={property ? w.resumeTitle(property.name) : w.title}
	subtitle={`${w.step(step, STEPS)} · ${w.steps[step - 1]}`}
	back="app/biens"
	backLabel={t.back}
/>

<main class="page pt-3 pb-10" data-testid="assistant" data-etape={step}>
	{#if !allowed}
		<FormAlert message={t.readOnly} tone="info" />
	{:else}
		<div class="grid gap-6 md:grid-cols-[14rem_1fr]">
			{#if !device.isPhone}
				<nav aria-label={w.title}>
					<ol class="space-y-1">
						{#each w.steps as label, i (label)}
							{@const n = i + 1}
							<li>
								{#if propertyId}
									<a
										href={resolve(`/app/biens/assistant?bien=${propertyId}&etape=${n}`)}
										class="flex min-h-11 items-center gap-2 rounded-lg px-3 text-base {n === step
											? 'bg-accent font-semibold'
											: 'text-muted-foreground'}"
										aria-current={n === step ? 'step' : undefined}
									>
										{#if n < step}<Check class="size-4" aria-hidden="true" />{:else}<span class="w-4 text-center">{n}</span>{/if}{label}
									</a>
								{:else}
									<span class="flex min-h-11 items-center gap-2 px-3 text-base {n === 1 ? 'font-semibold' : 'text-muted-foreground'}"
										><span class="w-4 text-center">{n}</span>{label}</span
									>
								{/if}
							</li>
						{/each}
					</ol>
				</nav>
			{/if}

			<section class="min-w-0 space-y-4">
				<FormAlert {message} />
				{#if step > 1}<FormAlert message={w.draftSaved} tone="info" />{/if}

				{#if propertyId && !property}
					<!-- Brouillon en cours de lecture sur l'appareil : le formulaire attend ses valeurs (jamais d'écrasement). -->
					<p class="text-base text-muted-foreground" role="status" data-testid="chargement">{fr.app.loading}</p>
				{:else if step === 1}
					<form class="space-y-4 rounded-2xl border bg-card p-4 md:p-6" onsubmit={saveStep1} novalidate data-testid="etape-1">
						<div class={field}>
							<label for="type" class={labelClass}>{t.type}</label>
							<select id="type" bind:value={type} class={select}>
								{#each PROPERTY_TYPES as v (v)}<option value={v}>{t.types[v]}</option>{/each}
							</select>
						</div>
						<div class={field}>
							<label for="operation" class={labelClass}>{t.operation}</label>
							<select id="operation" bind:value={operation} class={select}>
								{#each PROPERTY_OPERATIONS as v (v)}<option value={v}>{t.operations[v]}</option>{/each}
							</select>
						</div>
						<div class={field}>
							<label for="nom" class={labelClass}>{t.name}</label>
							<Input id="nom" bind:value={name} autocomplete="off" aria-invalid={errors.name ? 'true' : undefined} />
							<p class="text-sm text-muted-foreground">{t.nameHint}</p>
							{#if errors.name}<p class="text-base text-destructive">{errors.name}</p>{/if}
						</div>
						{#if !landlord}
							<div class={field}>
								<label for="proprietaire" class={labelClass}>{t.owner}</label>
								<select id="proprietaire" bind:value={ownerId} class={select} disabled={!!propertyId}>
									<option value="">{t.ownerChoose}</option>
									{#each owners as o (o.id)}<option value={o.id}>{o.name}</option>{/each}
								</select>
								{#if !owners.length}<p class="text-sm text-muted-foreground">{t.ownerMissing}</p>{/if}
								{#if errors.ownerId}<p class="text-base text-destructive">{errors.ownerId}</p>{/if}
							</div>
							{#if !propertyId && ownerId}
								<div class={field}>
									<label for="mandat" class={labelClass}>{t.mandate}</label>
									<select id="mandat" bind:value={mandateId} class={select}>
										<option value="">{t.mandateLater}</option>
										{#each ownerMandates as m (m.id)}<option value={m.id}>{fr.mandates.types[m.type]} · {m.startsOn}</option>{/each}
									</select>
								</div>
							{/if}
						{/if}
						<Button type="submit" size="lg" class="w-full md:w-auto" disabled={busy}><Save aria-hidden="true" />{w.next}</Button>
					</form>
				{:else if step === 2}
					<form class="space-y-4 rounded-2xl border bg-card p-4 md:p-6" onsubmit={saveStep2} novalidate data-testid="etape-2">
						<div class={field}>
							<label for="commune" class={labelClass}>{t.commune}</label>
							<select id="commune" bind:value={communeId} class={select} onchange={() => (neighborhoodId = '')}>
								<option value="">{t.communeChoose}</option>
								{#each communes as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
							</select>
						</div>
						<div class={field}>
							<label for="quartier" class={labelClass}>{t.neighborhood}</label>
							<select id="quartier" bind:value={neighborhoodId} class={select} disabled={!communeId}>
								<option value="">{t.neighborhoodChoose}</option>
								{#each communeNeighborhoods as n (n.id)}<option value={n.id}>{n.name}</option>{/each}
							</select>
							{#if errors.communeId}<p class="text-base text-destructive">{errors.communeId}</p>{/if}
						</div>
						<div class={field}>
							<label for="repere" class={labelClass}>{t.addressHint}</label>
							<Input id="repere" bind:value={addressHint} placeholder={t.addressHintPlaceholder} />
						</div>
						<fieldset class="space-y-2 rounded-xl border p-4">
							<legend class="px-1 font-semibold">{t.gps}</legend>
							<p class="text-sm text-muted-foreground">{t.gpsHint}</p>
							<p class="text-base" data-testid="point-gps">
								{#if gps}{gps.lat.toFixed(5)}, {gps.lng.toFixed(5)}{gps.accuracyM !== null
										? ` · ${t.gpsAccuracy(gps.accuracyM)}`
										: ''}{:else}{t.gpsNone}{/if}
							</p>
							<div class="flex flex-wrap gap-2">
								<Button type="button" variant="outline" disabled={gpsBusy} onclick={takeGps}
									><LocateFixed aria-hidden="true" />{gpsBusy ? t.gpsTaking : t.gpsTake}</Button
								>
								{#if gps}<Button type="button" variant="ghost" onclick={() => (gps = null)}><X aria-hidden="true" />{t.gpsClear}</Button
									>{/if}
							</div>
						</fieldset>
						<fieldset class="space-y-2 rounded-xl border p-4">
							<legend class="px-1 font-semibold">{t.declaredDocuments}</legend>
							{#each DECLARED_LAND_DOCUMENTS as d (d)}
								<label class="flex min-h-11 items-center gap-3 text-base">
									<input
										type="checkbox"
										class="size-5"
										checked={declared.includes(d)}
										onchange={(e) => toggleDeclared(d, (e.currentTarget as HTMLInputElement).checked)}
									/>{t.landDocuments[d]}
								</label>
							{/each}
						</fieldset>
						<div class="flex flex-wrap gap-2">
							<Button type="button" variant="outline" onclick={() => go(1)}><ArrowLeft aria-hidden="true" />{w.previous}</Button>
							<Button type="submit" disabled={busy}><Save aria-hidden="true" />{w.next}</Button>
						</div>
					</form>
				{:else if step === 3}
					<div class="space-y-4" data-testid="etape-3">
						{#if units.length}
							<ul class="divide-y rounded-2xl border bg-card">
								{#each units as u (u.id)}
									<li class="flex flex-wrap justify-between gap-2 p-3 text-base" data-testid="unite-ajoutee">
										<span class="font-medium">{u.label}</span><span class="text-muted-foreground">{t.unitTypes[u.type]}</span>
									</li>
								{/each}
							</ul>
						{:else if property?.type === 'land'}
							<FormAlert message={t.landNoUnit} tone="info" />
						{/if}
						<form class="space-y-4 rounded-2xl border bg-card p-4 md:p-6" onsubmit={addUnits} novalidate data-testid="ajout-unites">
							<h2 class="text-lg font-semibold">{t.addUnits}</h2>
							<div class="grid gap-4 sm:grid-cols-2">
								<div class={field}>
									<label for="type-unite" class={labelClass}>{t.unitType}</label>
									<select id="type-unite" bind:value={unitType} class={select}>
										{#each UNIT_TYPES as v (v)}<option value={v}>{t.unitTypes[v]}</option>{/each}
									</select>
								</div>
								<div class={field}>
									<label for="combien" class={labelClass}>{t.howMany}</label>
									<Input id="combien" type="number" inputmode="numeric" min="1" max="50" bind:value={count} />
								</div>
								<div class={field}>
									<label for="prefixe" class={labelClass}>{t.labelPrefix}</label>
									<Input id="prefixe" bind:value={prefix} placeholder={t.unitTypes[unitType]} />
								</div>
								<div class={field}>
									<label for="loyer" class={labelClass}>{t.rent}</label>
									<Input id="loyer" inputmode="numeric" bind:value={rent} aria-invalid={errors.rent ? 'true' : undefined} />
									{#if errors.rent}<p class="text-base text-destructive">{errors.rent}</p>{/if}
								</div>
								<div class={field}>
									<label for="chambres" class={labelClass}>{t.rooms.bedrooms}</label>
									<Input id="chambres" type="number" inputmode="numeric" min="0" max="50" bind:value={bedrooms} />
								</div>
								<div class={field}>
									<label for="salons" class={labelClass}>{t.rooms.livingRooms}</label>
									<Input id="salons" type="number" inputmode="numeric" min="0" max="50" bind:value={livingRooms} />
								</div>
							</div>
							{#if unitsAdded}<FormAlert message={unitsAdded} tone="info" />{/if}
							<Button type="submit" variant="outline" disabled={busy}
								><Plus aria-hidden="true" />{t.addUnitsSubmit(Math.min(50, Math.max(1, Number(count) || 1)))}</Button
							>
						</form>
						<div class="flex flex-wrap gap-2">
							<Button variant="outline" onclick={() => go(2)}><ArrowLeft aria-hidden="true" />{w.previous}</Button>
							<Button onclick={() => go(4)}><Save aria-hidden="true" />{w.next}</Button>
						</div>
					</div>
				{:else if step === 4 && property}
					<div class="space-y-4" data-testid="etape-4">
						{#if photoQueue.count}<FormAlert message={fr.photos.offlineQueue(photoQueue.count)} tone="info" />{/if}
						{#each units as u (u.id)}
							<section class="rounded-2xl border bg-card p-4 md:p-6">
								<PhotoGallery
									propertyId={property.id}
									unitId={u.id}
									label={u.label}
									gallery={galleryOf(media, property.id, u.id)}
									canEdit
									testid="galerie-unite"
								/>
							</section>
						{/each}
						<section class="rounded-2xl border bg-card p-4 md:p-6">
							<PhotoGallery
								propertyId={property.id}
								label={fr.photos.propertyPhotos}
								gallery={galleryOf(media, property.id, null)}
								canEdit
								testid="galerie-bien"
							/>
						</section>
						<div class="flex flex-wrap gap-2">
							<Button variant="outline" onclick={() => go(3)}><ArrowLeft aria-hidden="true" />{w.previous}</Button>
							<Button onclick={() => go(5)}><Save aria-hidden="true" />{w.next}</Button>
						</div>
					</div>
				{:else if step === 5 && property}
					<div class="space-y-4" data-testid="etape-5">
						{#if can(role, 'document.upload') && sync.online}
							<DocumentsSection propertyId={property.id} ownerId={property.ownerId} {documents} />
						{:else}
							<FormAlert message={w.documentsOnline} tone="info" />
						{/if}
						<div class="flex flex-wrap gap-2">
							<Button variant="outline" onclick={() => go(4)}><ArrowLeft aria-hidden="true" />{w.previous}</Button>
							<Button variant="outline" disabled={busy} onclick={() => finish(false)}>{w.finishDraft}</Button>
							<Button disabled={busy} onclick={() => finish(true)} data-testid="terminer"
								><CheckCircle2 aria-hidden="true" />{w.finish}</Button
							>
						</div>
					</div>
				{/if}
			</section>
		</div>
	{/if}
</main>
