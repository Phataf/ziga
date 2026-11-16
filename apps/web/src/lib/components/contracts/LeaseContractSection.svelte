<script lang="ts">
	/**
	 * Section « Contrat » de la fiche bail (lot 08 bis, docs/UX.md §10) : contrat du bail et avenants, lus sur
	 * l'appareil ; « Générer le contrat » (lieu, date, exemplaires) et « Faire un avenant » se font en ligne, le serveur
	 * génère en tâche de fond et la synchronisation ramène la version prête. Direction et gestion seulement.
	 */
	import { onMount } from 'svelte';
	import { FilePenLine, FilePlus2, FileText } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { formatDate, toIsoDate } from '@ziga/shared/dates';
	import { AMENDMENT_TYPES } from '@ziga/shared/contract-fields';
	import {
		contractSigningSchema,
		createAmendmentSchema,
		type AmendmentView,
		type ContractDetailView,
		type ContractView
	} from '@ziga/shared/contracts';
	import { newId } from '@ziga/shared/ids';
	import type { LeaseView } from '@ziga/shared/leases';
	import { formatFcfa, parseFcfa } from '@ziga/shared/money';
	import { can } from '@ziga/shared/permissions';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { contractTone } from '#lib/contracts/tones.ts';
	import { templatesInUse, toAmendment, toContract, toTemplate } from '#lib/contracts/views.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';

	let { lease, disabled = false }: { lease: LeaseView; /** Bail pas encore arrivé au serveur. */ disabled?: boolean } = $props();

	type Row = Record<string, unknown>;
	const t = fr.contracts;
	const today = toIsoDate();
	const canCreate = $derived(can(organizations.active?.role, 'contract.create'));
	const select = 'min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 text-base';

	let contractRows = $state<Row[]>([]);
	let amendmentRows = $state<Row[]>([]);
	let templateRows = $state<Row[]>([]);
	let panel = $state<'generate' | 'amend' | null>(null);
	let form = $state<Record<string, string>>({});
	let openEnded = $state(false);
	let message = $state<string | null>(null);
	let busy = $state(false);

	onMount(() => {
		const org = organizations.activeId;
		const onError = (error: Error) => (message = messageOf(error));
		const stops = [
			sync.watch<Row>(LOCAL_QUERIES.leaseContracts, [org, lease.id], (rows) => (contractRows = rows), onError),
			sync.watch<Row>(LOCAL_QUERIES.leaseAmendments, [org, lease.id], (rows) => (amendmentRows = rows), onError),
			sync.watch<Row>(LOCAL_QUERIES.contractTemplates, [org], (rows) => (templateRows = rows), onError)
		];
		return () => stops.forEach((stop) => stop());
	});

	const contracts = $derived<ContractView[]>(
		contractRows.map((r) =>
			toContract(r, {
				leaseVersion: lease.version,
				frozenLeaseVersion: r.frozen_lease_version == null ? null : Number(r.frozen_lease_version),
				recordedByName: null,
				today
			})
		)
	);
	const own = $derived(contracts.filter((c) => !c.amendmentId));
	const main = $derived(own.find((c) => c.status === 'signed') ?? own[0] ?? null);
	const contractOf = $derived(new Map(contracts.filter((c) => c.amendmentId).map((c) => [c.amendmentId!, c])));
	const amendments = $derived<AmendmentView[]>(amendmentRows.map((r) => toAmendment(r, contractOf.get(String(r.id))?.id ?? null)));
	const inUse = $derived(templatesInUse(templateRows.map((r) => toTemplate(r))));
	const canGenerate = $derived(canCreate && !main && lease.status !== 'cancelled' && lease.status !== 'ended');
	const canAmend = $derived(canCreate && ['signed', 'active', 'notice'].includes(lease.status) && main?.status === 'signed');

	function open(p: typeof panel) {
		panel = panel === p ? null : p;
		form = { date: today, copies: '3', from: today, type: 'renewal' };
		openEnded = false;
		message = null;
	}

	function signing() {
		return contractSigningSchema.safeParse({
			signingPlace: form.place ?? '',
			signingDate: form.date ?? '',
			copies: Number(form.copies)
		});
	}

	async function generate(event: SubmitEvent) {
		event.preventDefault();
		message = null;
		const parsed = signing();
		if (!parsed.success) return void (message = parsed.error.issues[0]!.message);
		busy = true;
		try {
			const created = await organizations.call<ContractDetailView>('POST', `/leases/${lease.id}/contract`, { id: newId(), ...parsed.data });
			await goto(resolve('/app/contrats/[id]', { id: created.id }));
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}

	async function amend(event: SubmitEvent) {
		event.preventDefault();
		message = null;
		const contract = signing();
		if (!contract.success) return void (message = contract.error.issues[0]!.message);
		const type = form.type as AmendmentView['type'];
		const amendment = createAmendmentSchema.safeParse({
			id: newId(),
			type,
			effectiveFrom: form.from ?? '',
			rent: type === 'rent_change' ? parseFcfa(form.rent ?? '') : null,
			charges: type === 'rent_change' ? (parseFcfa(form.charges ?? String(lease.charges)) ?? 0) : null,
			newEndsOn: type === 'renewal' && !openEnded ? form.ends || null : null,
			openEnded: type === 'renewal' && openEnded,
			description: form.description || null,
			expectedLeaseVersion: lease.version
		});
		if (!amendment.success) return void (message = amendment.error.issues[0]!.message);
		busy = true;
		try {
			const created = await organizations.call<ContractDetailView>('POST', `/leases/${lease.id}/amendments`, {
				amendment: amendment.data,
				contract: { id: newId(), ...contract.data }
			});
			await goto(resolve('/app/contrats/[id]', { id: created.id }));
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}
</script>

{#snippet signingFields()}
	<div class="grid gap-3 sm:grid-cols-3">
		<div class="space-y-1">
			<label for="lieu-signature" class="block font-medium">{t.place}</label>
			<Input id="lieu-signature" bind:value={form.place} autocomplete="address-level2" />
		</div>
		<div class="space-y-1">
			<label for="date-signature" class="block font-medium">{t.signingDate}</label>
			<Input id="date-signature" type="date" bind:value={form.date} />
		</div>
		<div class="space-y-1">
			<label for="exemplaires" class="block font-medium">{t.copies}</label>
			<Input id="exemplaires" inputmode="numeric" bind:value={form.copies} />
		</div>
	</div>
{/snippet}

<section class="space-y-3 rounded-2xl border bg-card p-4 md:p-6" data-testid="section-contrat">
	<h2 class="text-lg font-semibold">{t.section}</h2>
	<FormAlert {message} />
	{#if main}
		<a
			class="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-xl border p-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
			href={resolve('/app/contrats/[id]', { id: main.id })}
			data-testid="contrat-du-bail"
		>
			<span class="flex items-center gap-2 font-medium"><FileText class="size-5" aria-hidden="true" />{t.leaseContract}</span>
			<span class="flex flex-wrap gap-1">
				<Badge variant={contractTone(main.status)}>{t.status[main.status]}</Badge>
				{#if main.generationStatus === 'pending'}<Badge variant="info">{t.generating}</Badge>{/if}
				{#each main.alerts as a (a)}<Badge variant="warning">{t.alerts[a]}</Badge>{/each}
			</span>
		</a>
		{#if main.defaultTemplateNotice}<FormAlert message={t.defaultBanner} tone="info" />{/if}
	{:else}
		<p class="text-base text-muted-foreground">{t.sectionEmpty}</p>
	{/if}

	{#if amendments.length}
		<h3 class="pt-1 font-semibold">{t.amendments}</h3>
		<ul class="divide-y rounded-xl border" data-testid="avenants">
			{#each amendments as a (a.id)}
				<li class="p-3">
					{#if a.contractId}
						<a
							class="flex min-h-11 flex-wrap items-center justify-between gap-2"
							href={resolve('/app/contrats/[id]', { id: a.contractId })}
						>
							<span class="font-medium">{t.amendmentTitle(a.number)} · {t.amendmentTypes[a.type]} · {formatDate(a.effectiveFrom)}</span>
							<Badge variant={a.status === 'applied' ? 'success' : a.status === 'cancelled' ? 'secondary' : 'info'}
								>{t.amendmentStatus[a.status]}</Badge
							>
						</a>
					{:else}
						<span class="font-medium">{t.amendmentTitle(a.number)} · {t.amendmentTypes[a.type]}</span>
					{/if}
					{#if a.type === 'rent_change' && a.newRent !== null}<span class="block text-sm text-muted-foreground tabular-nums"
							>{formatFcfa(a.newRent)}</span
						>{/if}
				</li>
			{/each}
		</ul>
	{/if}

	{#if canCreate && (canGenerate || canAmend)}
		{#if !sync.online}
			<FormAlert message={t.online} tone="info" />
		{:else}
			<div class="flex flex-wrap gap-2">
				{#if canGenerate}
					<Button onclick={() => open('generate')} {disabled} data-testid="generer-contrat"
						><FilePlus2 aria-hidden="true" />{t.generate}</Button
					>
				{/if}
				{#if canAmend}
					<Button variant="outline" onclick={() => open('amend')} {disabled} data-testid="faire-avenant"
						><FilePenLine aria-hidden="true" />{t.amend}</Button
					>
				{/if}
			</div>
			{#if panel === 'generate'}
				<form class="space-y-3 rounded-xl border p-4" onsubmit={generate} novalidate data-testid="formulaire-generation">
					<p class="text-sm text-muted-foreground">{t.generateHint}</p>
					{#if inUse.lease.legalReviewPending}<FormAlert message={t.defaultBanner} tone="info" />{/if}
					{@render signingFields()}
					<Button type="submit" disabled={busy}>{t.generateSubmit}</Button>
				</form>
			{:else if panel === 'amend'}
				<form class="space-y-3 rounded-xl border p-4" onsubmit={amend} novalidate data-testid="formulaire-avenant">
					<p class="text-sm text-muted-foreground">{t.amendmentHint}</p>
					{#if inUse.amendment.legalReviewPending}<FormAlert message={t.defaultBanner} tone="info" />{/if}
					<div class="grid gap-3 sm:grid-cols-2">
						<div class="space-y-1">
							<label for="objet-avenant" class="block font-medium">{t.amendmentType}</label>
							<select id="objet-avenant" class={select} bind:value={form.type} data-testid="objet-avenant">
								{#each AMENDMENT_TYPES as type (type)}<option value={type}>{t.amendmentTypes[type]}</option>{/each}
							</select>
						</div>
						<div class="space-y-1">
							<label for="effet-avenant" class="block font-medium">{t.effectiveFrom}</label>
							<Input id="effet-avenant" type="date" bind:value={form.from} />
						</div>
					</div>
					{#if form.type === 'rent_change'}
						<div class="grid gap-3 sm:grid-cols-2">
							<div class="space-y-1">
								<label for="loyer-avenant" class="block font-medium">{t.newRent}</label>
								<Input id="loyer-avenant" inputmode="numeric" bind:value={form.rent} />
							</div>
							<div class="space-y-1">
								<label for="charges-avenant" class="block font-medium">{t.newCharges}</label>
								<Input id="charges-avenant" inputmode="numeric" bind:value={form.charges} placeholder={String(lease.charges)} />
							</div>
						</div>
					{:else if form.type === 'renewal'}
						<div class="grid gap-3 sm:grid-cols-2">
							<div class="space-y-1">
								<label for="fin-avenant" class="block font-medium">{t.newEndsOn}</label>
								<Input id="fin-avenant" type="date" bind:value={form.ends} disabled={openEnded} />
							</div>
							<label class="flex min-h-12 items-center gap-3 self-end text-base">
								<input type="checkbox" class="size-5" bind:checked={openEnded} />{t.openEnded}
							</label>
						</div>
					{:else}
						<div class="space-y-1">
							<label for="modification-avenant" class="block font-medium">{t.description}</label>
							<textarea
								id="modification-avenant"
								class="min-h-24 w-full rounded-lg border-2 border-input bg-card p-3 text-base"
								bind:value={form.description}></textarea>
						</div>
					{/if}
					{@render signingFields()}
					<Button type="submit" disabled={busy}>{t.amendmentSubmit}</Button>
				</form>
			{/if}
		{/if}
	{/if}
</section>
