<script lang="ts">
	/**
	 * Fiche locataire (lot 08) : coordonnées, état civil et pièce d'identité (directeur et gestionnaire seulement : les
	 * autres rôles n'en reçoivent aucune ligne), baux et reste à payer exigible. Lue sur l'appareil ; une modification
	 * part par la synchronisation.
	 */
	import { onMount } from 'svelte';
	import { Pencil, Save, X } from '@lucide/svelte';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { formatDate, toIsoDate } from '@ziga/shared/dates';
	import {
		outstandingBalance,
		tenantIdentitySchema,
		tenantSchema,
		type LeaseView,
		type TenantIdentity,
		type TenantView
	} from '@ziga/shared/leases';
	import { formatFcfa } from '@ziga/shared/money';
	import { ID_DOCUMENT_LABELS, ID_DOCUMENT_TYPES } from '@ziga/shared/organizations';
	import { can } from '@ziga/shared/permissions';
	import { formatPhone } from '@ziga/shared/phone';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { toLease, toRentDue, toTenant, toTenantIdentity } from '#lib/leases/views.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';
	import { saveTenant, saveTenantIdentity } from '#lib/sync/writes.ts';

	type Row = Record<string, unknown>;
	const t = fr.tenants;
	const tl = fr.leases;
	const today = toIsoDate();
	const role = $derived(organizations.active?.role);
	const canEdit = $derived(can(role, 'tenant.update'));
	const canIdentity = $derived(can(role, 'tenant.read_identity'));
	const select = 'min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 text-base';
	const id = $derived(page.params.id ?? '');

	let tenant = $state<TenantView | null>(null);
	let identity = $state<TenantIdentity | null>(null);
	let identityExists = $state(false);
	let leases = $state<LeaseView[]>([]);
	let dues = $state<Row[]>([]);
	let loaded = $state(false);
	let message = $state<string | null>(null);
	let saved = $state<string | null>(null);
	let editing = $state(false);
	let form = $state<Record<string, string>>({});
	let errors = $state<Record<string, string>>({});

	onMount(() => {
		const org = organizations.activeId;
		const onError = (error: Error) => (message = messageOf(error));
		const stops = [
			sync.watch<Row>(
				LOCAL_QUERIES.tenant,
				[org, id],
				(rows) => {
					tenant = rows[0] ? toTenant(rows[0]) : null;
					loaded = true;
				},
				onError
			),
			sync.watch<Row>(LOCAL_QUERIES.tenantLeases, [org, id], (rows) => (leases = rows.map((r) => toLease(r))), onError),
			sync.watch<Row>(LOCAL_QUERIES.tenantDues, [org, id], (rows) => (dues = rows), onError)
		];
		if (canIdentity) {
			stops.push(
				sync.watch<Row>(LOCAL_QUERIES.tenantIdentity, [org, id], (rows) => {
					identity = toTenantIdentity(rows[0]);
					identityExists = !!rows[0];
				})
			);
		}
		return () => stops.forEach((stop) => stop());
	});

	const outstanding = $derived(
		outstandingBalance(
			dues.map((d) => toRentDue(d, today)).map((d) => ({ ...d, waived: d.status === 'waived' })),
			today
		)
	);

	function startEdit() {
		if (!tenant) return;
		editing = true;
		saved = null;
		errors = {};
		form = {
			civility: tenant.civility ?? '',
			fullName: tenant.fullName,
			phone: tenant.phone ?? '',
			secondaryPhone: tenant.secondaryPhone ?? '',
			nationality: tenant.nationality ?? '',
			profession: tenant.profession ?? '',
			previousAddress: tenant.previousAddress ?? '',
			emergencyContactName: tenant.emergencyContactName ?? '',
			emergencyContactPhone: tenant.emergencyContactPhone ?? '',
			notes: tenant.notes ?? '',
			birthDate: identity?.birthDate ?? '',
			birthPlace: identity?.birthPlace ?? '',
			idType: identity?.idType ?? '',
			idTypeOther: identity?.idTypeOther ?? '',
			idNumber: identity?.idNumber ?? '',
			idIssuedOn: identity?.idIssuedOn ?? '',
			idIssuedBy: identity?.idIssuedBy ?? ''
		};
	}

	const blank = (v: string | undefined) => (v && v.trim() ? v : null);

	async function save(event: SubmitEvent) {
		event.preventDefault();
		const org = organizations.activeId;
		if (!org || !tenant) return;
		message = null;
		const parsed = tenantSchema.safeParse({
			civility: blank(form.civility),
			fullName: form.fullName,
			phone: blank(form.phone),
			secondaryPhone: blank(form.secondaryPhone),
			nationality: blank(form.nationality),
			profession: blank(form.profession),
			previousAddress: blank(form.previousAddress),
			emergencyContactName: blank(form.emergencyContactName),
			emergencyContactPhone: blank(form.emergencyContactPhone),
			notes: blank(form.notes)
		});
		const ident = canIdentity
			? tenantIdentitySchema.safeParse({
					birthDate: blank(form.birthDate),
					birthPlace: blank(form.birthPlace),
					idType: blank(form.idType),
					idTypeOther: blank(form.idTypeOther),
					idNumber: blank(form.idNumber),
					idIssuedOn: blank(form.idIssuedOn),
					idIssuedBy: blank(form.idIssuedBy)
				})
			: null;
		const out: Record<string, string> = {};
		if (!parsed.success) for (const i of parsed.error.issues) out[String(i.path[0] ?? '')] ??= i.message;
		if (ident && !ident.success) for (const i of ident.error.issues) out[String(i.path[0] ?? '')] ??= i.message;
		errors = out;
		if (!parsed.success || (ident && !ident.success)) return;
		try {
			const db = sync.db ?? (await sync.start());
			await saveTenant(db, org, tenant.id, parsed.data);
			if (ident?.success) await saveTenantIdentity(db, org, tenant.id, ident.data, identityExists);
			editing = false;
			saved = t.saved;
		} catch (error) {
			message = messageOf(error);
		}
	}

	const value = (v: string | null | undefined) => (v ? v : t.identityMissing);
</script>

<PageHeader
	title={tenant?.fullName ?? t.title}
	subtitle={tenant?.phone ? formatPhone(tenant.phone) : undefined}
	back="app/locataires"
	backLabel={t.back}
/>

<main class="page space-y-4 pt-3 pb-10" data-testid="fiche-locataire">
	<FormAlert {message} />
	{#if saved}<FormAlert message={saved} tone="info" />{/if}
	{#if loaded && !tenant}
		<FormAlert message={t.notFound} />
	{:else if tenant}
		<section class="space-y-3 rounded-2xl border bg-card p-4 md:p-6">
			<div class="flex flex-wrap items-center justify-between gap-2">
				<h2 class="text-lg font-semibold">{t.outstanding}</h2>
				<span class="text-lg font-semibold tabular-nums" data-testid="reste-a-payer"
					>{outstanding ? formatFcfa(outstanding) : t.nothingDue}</span
				>
			</div>
		</section>

		{#if editing}
			<form class="space-y-4 rounded-2xl border bg-card p-4 md:p-6" onsubmit={save} novalidate data-testid="modifier-locataire">
				<div class="grid gap-4 sm:grid-cols-2">
					<div class="space-y-1">
						<label for="civilite" class="block font-medium">{t.civility}</label>
						<select id="civilite" bind:value={form.civility} class={select}>
							<option value=""></option>
							{#each Object.entries(t.civilities) as [k, label] (k)}<option value={k}>{label}</option>{/each}
						</select>
					</div>
					{#each [['fullName', t.name], ['phone', t.phone], ['secondaryPhone', t.secondaryPhone], ['nationality', t.nationality], ['profession', t.profession], ['previousAddress', t.previousAddress], ['emergencyContactName', t.emergencyContact], ['emergencyContactPhone', t.emergencyContactPhone], ['notes', t.notes]] as [k, label] (k)}
						<div class="space-y-1">
							<label for={`f-${k}`} class="block font-medium">{label}</label>
							<Input
								id={`f-${k}`}
								bind:value={form[k!]}
								inputmode={k!.toLowerCase().includes('phone') ? 'tel' : undefined}
								aria-invalid={errors[k!] ? 'true' : undefined}
							/>
							{#if errors[k!]}<p class="text-base text-destructive">{errors[k!]}</p>{/if}
						</div>
					{/each}
				</div>
				{#if canIdentity}
					<fieldset class="space-y-3 rounded-xl border p-4">
						<legend class="px-1 font-semibold">{t.identity}</legend>
						<p class="text-sm text-muted-foreground">{t.identityHint}</p>
						<div class="grid gap-4 sm:grid-cols-2">
							<div class="space-y-1">
								<label for="f-birthDate" class="block font-medium">{t.birthDate}</label>
								<Input id="f-birthDate" type="date" bind:value={form.birthDate} />
							</div>
							<div class="space-y-1">
								<label for="f-birthPlace" class="block font-medium">{t.birthPlace}</label>
								<Input id="f-birthPlace" bind:value={form.birthPlace} />
							</div>
							<div class="space-y-1">
								<label for="f-idType" class="block font-medium">{t.idType}</label>
								<select id="f-idType" bind:value={form.idType} class={select}>
									<option value=""></option>
									{#each ID_DOCUMENT_TYPES as v (v)}<option value={v}>{ID_DOCUMENT_LABELS[v]}</option>{/each}
								</select>
							</div>
							{#if form.idType === 'other'}
								<div class="space-y-1">
									<label for="f-idTypeOther" class="block font-medium">{t.idTypeOther}</label>
									<Input id="f-idTypeOther" bind:value={form.idTypeOther} />
									{#if errors.idTypeOther}<p class="text-base text-destructive">{errors.idTypeOther}</p>{/if}
								</div>
							{/if}
							<div class="space-y-1">
								<label for="f-idNumber" class="block font-medium">{t.idNumber}</label>
								<Input id="f-idNumber" bind:value={form.idNumber} />
							</div>
							<div class="space-y-1">
								<label for="f-idIssuedOn" class="block font-medium">{t.idIssuedOn}</label>
								<Input id="f-idIssuedOn" type="date" bind:value={form.idIssuedOn} />
							</div>
							<div class="space-y-1">
								<label for="f-idIssuedBy" class="block font-medium">{t.idIssuedBy}</label>
								<Input id="f-idIssuedBy" bind:value={form.idIssuedBy} />
							</div>
						</div>
					</fieldset>
				{/if}
				<div class="flex flex-wrap gap-2">
					<Button type="submit"><Save aria-hidden="true" />{t.save}</Button>
					<Button type="button" variant="outline" onclick={() => (editing = false)}><X aria-hidden="true" />{t.cancel}</Button>
				</div>
			</form>
		{:else}
			<section class="space-y-3 rounded-2xl border bg-card p-4 md:p-6" data-testid="coordonnees">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<h2 class="text-lg font-semibold">{t.title}</h2>
					{#if canEdit}<Button variant="outline" onclick={startEdit}><Pencil aria-hidden="true" />{t.edit}</Button>{/if}
				</div>
				<dl class="grid gap-3 sm:grid-cols-2">
					{#each [[t.name, `${tenant.civility ? `${t.civilities[tenant.civility]} ` : ''}${tenant.fullName}`], [t.phone, tenant.phone ? formatPhone(tenant.phone) : null], [t.secondaryPhone, tenant.secondaryPhone ? formatPhone(tenant.secondaryPhone) : null], [t.nationality, tenant.nationality], [t.profession, tenant.profession], [t.previousAddress, tenant.previousAddress], [t.emergencyContact, tenant.emergencyContactName], [t.notes, tenant.notes]] as [label, v] (label)}
						{#if v}
							<div class="min-w-0">
								<dt class="text-sm text-muted-foreground">{label}</dt>
								<dd class="text-base break-words">{v}</dd>
							</div>
						{/if}
					{/each}
				</dl>
			</section>
			{#if canIdentity}
				<section class="space-y-3 rounded-2xl border bg-card p-4 md:p-6" data-testid="etat-civil">
					<h2 class="text-lg font-semibold">{t.identity}</h2>
					<p class="text-sm text-muted-foreground">{t.identityHint}</p>
					<dl class="grid gap-3 sm:grid-cols-2">
						<div>
							<dt class="text-sm text-muted-foreground">{t.birthDate}</dt>
							<dd class="text-base">{identity?.birthDate ? formatDate(identity.birthDate) : t.identityMissing}</dd>
						</div>
						<div>
							<dt class="text-sm text-muted-foreground">{t.birthPlace}</dt>
							<dd class="text-base">{value(identity?.birthPlace)}</dd>
						</div>
						<div>
							<dt class="text-sm text-muted-foreground">{t.idType}</dt>
							<dd class="text-base">
								{identity?.idType
									? identity.idType === 'other'
										? identity.idTypeOther
										: ID_DOCUMENT_LABELS[identity.idType]
									: t.identityMissing}
							</dd>
						</div>
						<div>
							<dt class="text-sm text-muted-foreground">{t.idNumber}</dt>
							<dd class="text-base" data-testid="numero-piece">{value(identity?.idNumber)}</dd>
						</div>
					</dl>
				</section>
			{/if}
		{/if}

		<section class="space-y-3 rounded-2xl border bg-card p-4 md:p-6" data-testid="baux-locataire">
			<h2 class="text-lg font-semibold">{t.leases}</h2>
			{#if !leases.length}
				<p class="text-base text-muted-foreground">{t.noLease}</p>
			{:else}
				<ul class="divide-y rounded-xl border">
					{#each leases as l (l.id)}
						<li>
							<a
								class="flex min-h-12 flex-wrap items-center justify-between gap-2 p-3"
								href={resolve('/app/baux/[id]', { id: l.id })}
								data-testid="bail"
							>
								<span class="text-base">{formatDate(l.startsOn)}{l.endsOn ? ` → ${formatDate(l.endsOn)}` : ''} · {formatFcfa(l.rent)}</span>
								<Badge variant={l.status === 'active' ? 'success' : 'secondary'}>{tl.status[l.status]}</Badge>
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}
</main>
