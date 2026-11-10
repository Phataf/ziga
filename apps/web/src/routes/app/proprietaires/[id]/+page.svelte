<script lang="ts">
	/**
	 * Fiche propriétaire (lot 06) : coordonnées, mandats et leurs versions, lus dans la base de l'appareil. Les
	 * modifications s'écrivent sur l'appareil et partent par la synchronisation ; le serveur décide de la version, de la
	 * date de révocation et du statut (docs/SYNC.md §6). Un refus revient dans « Modifications non acceptées ».
	 */
	import { onMount } from 'svelte';
	import { Archive, FilePlus, Pencil, Save } from '@lucide/svelte';
	import { page } from '$app/state';
	import { formatDate, toIsoDate } from '@ziga/shared/dates';
	import { newId } from '@ziga/shared/ids';
	import { formatFcfa } from '@ziga/shared/money';
	import { formatRateBp, revokeMandateSchema, type MandateVersionView, type MandateView, type OwnerView } from '@ziga/shared/owners';
	import { can } from '@ziga/shared/permissions';
	import { COUNTRIES, formatPhone } from '@ziga/shared/phone';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import MandateCard from '#lib/components/owners/MandateCard.svelte';
	import MandateFields from '#lib/components/owners/MandateFields.svelte';
	import OwnerFields from '#lib/components/owners/OwnerFields.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import Sheet from '#lib/components/ui/sheet/Sheet.svelte';
	import { messageOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import {
		emptyMandateForm,
		mandateFromForm,
		mandateToForm,
		ownerFromForm,
		ownerToForm,
		termsFromForm,
		type Errors,
		type MandateForm,
		type OwnerForm
	} from '#lib/owners/forms.ts';
	import { toMandate, toOwner, toVersion } from '#lib/owners/views.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';
	import { archiveOwner, createMandate, revokeMandate, saveMandateTerms, saveOwner } from '#lib/sync/writes.ts';

	const t = fr.owners;
	const tm = fr.mandates;
	const today = toIsoDate();
	const id = $derived(page.params.id ?? '');
	const role = $derived(organizations.active?.role);
	const landlord = $derived(organizations.active?.type === 'landlord');
	const allowed = $derived(can(role, 'owner.read') && !landlord);
	const canEditOwner = $derived(can(role, 'owner.update'));
	const canCreateMandate = $derived(can(role, 'mandate.create'));
	const canEditMandate = $derived(can(role, 'mandate.update') && can(role, 'mandate.revoke'));

	let owner = $state<OwnerView | null>(null);
	let loaded = $state(false);
	let mandates = $state<MandateView[]>([]);
	let message = $state<string | null>(null);
	let info = $state<string | null>(page.state.saved ? (sync.online ? t.saved : t.savedOffline) : null);

	onMount(() => {
		if (!allowed) return;
		const org = organizations.activeId;
		const onError = (error: Error) => (message = messageOf(error));
		const stopOwner = sync.watch<Record<string, unknown>>(
			LOCAL_QUERIES.owner,
			[org, id],
			(rows) => {
				owner = rows[0] ? toOwner(rows[0]) : null;
				loaded = true;
			},
			onError
		);
		const stopMandates = sync.watch<Record<string, unknown>>(
			LOCAL_QUERIES.ownerMandates,
			[org, id],
			(rows) => (mandates = rows.map(toMandate)),
			onError
		);
		return () => {
			stopOwner();
			stopMandates();
		};
	});

	async function db() {
		return sync.db ?? (await sync.start());
	}
	const savedMessage = () => (sync.online ? t.mandateSaved : t.savedOffline);

	// ---- coordonnées
	let editOpen = $state(false);
	let ownerForm = $state<OwnerForm | null>(null);
	let ownerErrors = $state<Errors>({});
	function openEdit() {
		if (!owner) return;
		ownerForm = ownerToForm(owner);
		ownerErrors = {};
		editOpen = true;
	}
	async function submitOwner(event: SubmitEvent) {
		event.preventDefault();
		if (!ownerForm || !owner) return;
		const r = ownerFromForm(ownerForm);
		if (!r.ok) {
			ownerErrors = r.errors;
			return;
		}
		try {
			await saveOwner(await db(), organizations.activeId!, owner.id, r.value);
			info = sync.online ? t.saved : t.savedOffline;
			editOpen = false;
		} catch (error) {
			message = messageOf(error);
		}
	}

	// ---- mandats : création et modification
	let mandateOpen = $state(false);
	let mandateForm = $state<MandateForm | null>(null);
	let mandateErrors = $state<Errors>({});
	let editing = $state<MandateView | null>(null);
	function openNewMandate() {
		editing = null;
		mandateForm = emptyMandateForm(today);
		mandateErrors = {};
		mandateOpen = true;
	}
	function openEditMandate(m: MandateView) {
		editing = m;
		mandateForm = mandateToForm(m);
		mandateErrors = {};
		mandateOpen = true;
	}
	async function submitMandate(event: SubmitEvent) {
		event.preventDefault();
		if (!mandateForm || !owner) return;
		try {
			if (editing) {
				const r = termsFromForm(mandateForm);
				if (!r.ok) return void (mandateErrors = r.errors);
				await saveMandateTerms(await db(), organizations.activeId!, editing.id, r.value);
			} else {
				const r = mandateFromForm(mandateForm, { id: newId(), ownerId: owner.id });
				if (!r.ok) return void (mandateErrors = r.errors);
				await createMandate(await db(), organizations.activeId!, r.value);
			}
			info = savedMessage();
			mandateOpen = false;
		} catch (error) {
			message = messageOf(error);
		}
	}

	// ---- révocation
	let revokeOpen = $state(false);
	let revoking = $state<MandateView | null>(null);
	let reason = $state('');
	let reasonError = $state<string | undefined>();
	function openRevoke(m: MandateView) {
		revoking = m;
		reason = '';
		reasonError = undefined;
		revokeOpen = true;
	}
	async function submitRevoke(event: SubmitEvent) {
		event.preventDefault();
		if (!revoking) return;
		const r = revokeMandateSchema.safeParse({ reason });
		if (!r.success) return void (reasonError = r.error.issues[0]?.message);
		try {
			await revokeMandate(await db(), organizations.activeId!, revoking.id, r.data.reason);
			info = savedMessage();
			revokeOpen = false;
		} catch (error) {
			message = messageOf(error);
		}
	}

	// ---- historique
	let historyOpen = $state(false);
	let versions = $state<MandateVersionView[]>([]);
	let stopHistory: (() => void) | null = null;
	function openHistory(m: MandateView) {
		stopHistory?.();
		versions = [];
		stopHistory = sync.watch<Record<string, unknown>>(
			LOCAL_QUERIES.mandateVersions,
			[organizations.activeId, m.id],
			(rows) => (versions = rows.map(toVersion))
		);
		historyOpen = true;
	}
	$effect(() => {
		if (!historyOpen) {
			stopHistory?.();
			stopHistory = null;
		}
	});
	const commissionOf = (v: MandateVersionView) => {
		const c = v.commission;
		if (!c) return tm.noCommission;
		return c.basis === 'percent_of_collected'
			? tm.commissionText[c.basis]!(formatRateBp(c.rateBp))
			: tm.commissionText[c.basis]!(formatFcfa(c.amount));
	};

	// ---- archivage
	let archiveOpen = $state(false);
	const hasOpenMandate = $derived(mandates.some((m) => m.status === 'active' && (!m.endsOn || m.endsOn >= today)));
	async function submitArchive() {
		if (!owner) return;
		try {
			await archiveOwner(await db(), organizations.activeId!, owner.id);
			info = sync.online ? t.saved : t.savedOffline;
			archiveOpen = false;
		} catch (error) {
			message = messageOf(error);
		}
	}

	const countryName = (iso: string) => COUNTRIES.find((c) => c.iso === iso)?.name ?? iso;
</script>

<PageHeader title={owner?.name ?? t.title} subtitle={owner ? t.types[owner.type] : undefined} back="app/proprietaires" backLabel={t.back} />

<main class="page space-y-4 pt-3 pb-10" data-testid="fiche-proprietaire">
	{#if !allowed}
		<FormAlert message={landlord ? t.landlord : fr.app.notFound} tone={landlord ? 'info' : undefined} />
	{:else if loaded && !owner}
		<FormAlert message={t.notFound} />
	{:else if owner}
		<FormAlert {message} />
		<FormAlert message={info} tone="info" />

		<section class="space-y-3 rounded-2xl border bg-card p-4 md:p-6" aria-labelledby="titre-coordonnees">
			<div class="flex flex-wrap items-center justify-between gap-2">
				<h2 id="titre-coordonnees" class="text-lg font-semibold">{t.contact}</h2>
				{#if owner.status === 'archived'}<Badge variant="secondary">{t.archived}</Badge>{/if}
			</div>
			<dl class="grid gap-x-6 gap-y-2 text-base sm:grid-cols-[auto_1fr]">
				<dt class="text-muted-foreground">{t.phone}</dt>
				<dd class="tabular-nums" data-testid="telephone-proprietaire">{formatPhone(owner.phone)}</dd>
				<dt class="text-muted-foreground">{t.country}</dt>
				<dd>{countryName(owner.country)}</dd>
				{#if owner.representative}
					<dt class="text-muted-foreground">{t.representative}</dt>
					<dd>{owner.representative.name} · {formatPhone(owner.representative.phone)}</dd>
				{/if}
				{#if owner.email}<dt class="text-muted-foreground">{t.email}</dt>
					<dd class="break-all">{owner.email}</dd>{/if}
				{#if owner.address}<dt class="text-muted-foreground">{t.address}</dt>
					<dd>{owner.address}</dd>{/if}
				{#if owner.notes}<dt class="text-muted-foreground">{t.notes}</dt>
					<dd class="break-words whitespace-pre-line">{owner.notes}</dd>{/if}
			</dl>
			{#if canEditOwner && owner.status === 'active'}
				<div class="flex flex-wrap gap-2">
					<Button variant="outline" onclick={openEdit}><Pencil aria-hidden="true" />{t.edit}</Button>
					<Button variant="ghost" onclick={() => (archiveOpen = true)}><Archive aria-hidden="true" />{t.archive}</Button>
				</div>
			{/if}
		</section>

		<section class="space-y-3" aria-labelledby="titre-mandats">
			<div class="flex flex-wrap items-center justify-between gap-2">
				<h2 id="titre-mandats" class="text-lg font-semibold">{tm.title}</h2>
				{#if canCreateMandate && owner.status === 'active'}
					<Button variant="outline" onclick={openNewMandate}><FilePlus aria-hidden="true" />{tm.new}</Button>
				{/if}
			</div>
			{#if !mandates.length}
				<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground">{tm.none}</p>
			{:else}
				<div class="grid gap-3 lg:grid-cols-2">
					{#each mandates as m (m.id)}
						<MandateCard
							mandate={m}
							{today}
							manage={canEditMandate}
							onedit={() => openEditMandate(m)}
							onrevoke={() => openRevoke(m)}
							onhistory={() => openHistory(m)}
						/>
					{/each}
				</div>
			{/if}
		</section>

		<section class="space-y-2 rounded-2xl border bg-card p-4 md:p-6" aria-labelledby="titre-biens">
			<h2 id="titre-biens" class="text-lg font-semibold">{t.properties}</h2>
			<p class="text-base text-muted-foreground">{t.propertiesSoon}</p>
		</section>
	{/if}
</main>

<Sheet bind:open={editOpen} labelledby="titre-modifier-proprietaire">
	<h2 id="titre-modifier-proprietaire" class="pr-10 text-xl font-bold">{t.editTitle}</h2>
	{#if ownerForm}
		<form class="mt-4 space-y-4" onsubmit={submitOwner} novalidate>
			<OwnerFields bind:form={ownerForm} errors={ownerErrors} prefix="modifier" />
			<Button type="submit" size="lg" class="w-full"><Save aria-hidden="true" />{t.save}</Button>
		</form>
	{/if}
</Sheet>

<Sheet bind:open={mandateOpen} labelledby="titre-mandat">
	<h2 id="titre-mandat" class="pr-10 text-xl font-bold">{editing ? tm.editTitle : tm.new}</h2>
	{#if mandateForm}
		<form class="mt-4 space-y-4" onsubmit={submitMandate} novalidate data-testid="formulaire-mandat">
			{#if editing}<FormAlert message={tm.newVersion(editing.version + 1)} tone="info" />{/if}
			<MandateFields bind:form={mandateForm} errors={mandateErrors} prefix="feuille-mandat" typeEditable={!editing} />
			<Button type="submit" size="lg" class="w-full"><Save aria-hidden="true" />{t.save}</Button>
		</form>
	{/if}
</Sheet>

<Sheet bind:open={revokeOpen} labelledby="titre-revocation">
	<h2 id="titre-revocation" class="pr-10 text-xl font-bold">{tm.revokeTitle}</h2>
	<form class="mt-4 space-y-4" onsubmit={submitRevoke} novalidate>
		<p class="text-base">{tm.revokeHint}</p>
		<div class="space-y-1">
			<label for="motif-revocation" class="block font-medium">{tm.reason}</label>
			<textarea
				id="motif-revocation"
				bind:value={reason}
				rows="3"
				aria-invalid={reasonError ? 'true' : undefined}
				aria-describedby={reasonError ? 'motif-revocation-erreur' : undefined}
				class="w-full rounded-lg border-2 border-input bg-card px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30"
			></textarea>
			{#if reasonError}<p id="motif-revocation-erreur" class="text-base text-destructive">{reasonError}</p>{/if}
		</div>
		<div class="flex flex-wrap gap-2">
			<Button type="submit" variant="destructive">{tm.revoke}</Button>
			<Button variant="outline" onclick={() => (revokeOpen = false)}>{t.cancel}</Button>
		</div>
	</form>
</Sheet>

<Sheet bind:open={historyOpen} labelledby="titre-historique" side="right">
	<h2 id="titre-historique" class="pr-10 text-xl font-bold">{tm.historyTitle}</h2>
	{#if !versions.length}
		<p class="mt-4 text-base text-muted-foreground">{tm.historyEmpty}</p>
	{:else}
		<ol class="mt-4 space-y-3" data-testid="versions">
			{#each versions as v (v.version)}
				<li class="space-y-1 rounded-xl border p-3" data-testid="version">
					<p class="flex flex-wrap items-center justify-between gap-2">
						<span class="font-semibold">{tm.version(v.version)}</span>
						<span class="text-sm text-muted-foreground">{v.recordedAt ? formatDate(v.recordedAt) : ''}</span>
					</p>
					<p class="text-base">{tm.statuses[v.status]}</p>
					<p class="text-base">{tm.period(formatDate(v.startsOn), v.endsOn ? formatDate(v.endsOn) : null)}</p>
					<p class="text-base">{commissionOf(v)}</p>
					<p class="text-sm text-muted-foreground">
						{[
							v.canPublish && tm.authorization.canPublish,
							v.canTakePhotos && tm.authorization.canTakePhotos,
							v.canCollectFunds && tm.authorization.canCollectFunds,
							v.canSignLeases && tm.authorization.canSignLeases
						]
							.filter(Boolean)
							.join(' · ') || tm.noAuthorization}
					</p>
					{#if v.revocationReason}<p class="text-base">{tm.revokedBecause(v.revocationReason)}</p>{/if}
				</li>
			{/each}
		</ol>
	{/if}
</Sheet>

<Sheet bind:open={archiveOpen} labelledby="titre-archivage">
	<h2 id="titre-archivage" class="pr-10 text-xl font-bold">{t.archive}</h2>
	<div class="mt-4 space-y-4">
		{#if hasOpenMandate}
			<FormAlert message={t.archiveBlocked} tone="info" />
			<Button variant="outline" onclick={() => (archiveOpen = false)}>{t.cancel}</Button>
		{:else}
			<p class="text-base">{t.archiveConfirm}</p>
			<div class="flex flex-wrap gap-2">
				<Button variant="destructive" onclick={submitArchive}><Archive aria-hidden="true" />{t.archive}</Button>
				<Button variant="outline" onclick={() => (archiveOpen = false)}>{t.cancel}</Button>
			</div>
		{/if}
	</div>
</Sheet>
