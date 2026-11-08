<script lang="ts">
	/**
	 * Paramètres de l'organisation (lot 03, directeur) : fiche, coordonnées, RCCM, IFU, boîte postale, représentant
	 * légal (D24) et logo, avec l'aperçu de l'en-tête des reçus. Chaque enregistrement écrit sa ligne d'audit
	 * (valeur avant et après) ; un document déjà émis ne change jamais (D29).
	 */
	import { onDestroy, onMount } from 'svelte';
	import { ImageUp, Save } from '@lucide/svelte';
	import {
		ID_DOCUMENT_LABELS,
		ID_DOCUMENT_TYPES,
		LOGO_MAX_BYTES,
		LOGO_MIME_TYPES,
		updateOrganizationSchema,
		type OrganizationView
	} from '@ziga/shared/organizations';
	import { can } from '@ziga/shared/permissions';
	import { toE164 } from '@ziga/shared/phone';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PhoneField from '#lib/components/auth/PhoneField.svelte';
	import ReceiptHeader from '#lib/components/org/ReceiptHeader.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { fieldErrors, messageOf, phoneOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';

	const t = fr.settings;
	const editable = $derived(can(organizations.active?.role, 'organization.update'));
	let view = $state<OrganizationView | null>(null);
	let form = $state({
		legalName: '',
		tradeName: '',
		address: '',
		commune: '',
		poBox: '',
		rccm: '',
		ifu: '',
		rep: {
			name: '',
			title: '',
			profession: '',
			address: '',
			nationality: '',
			idType: '',
			idTypeOther: '',
			idNumber: '',
			idIssuedOn: '',
			idIssuedBy: ''
		}
	});
	let phone = $state('');
	let country = $state('226');
	let errors = $state<Record<string, string>>({});
	let message = $state<string | null>(null);
	let info = $state<string | null>(null);
	let logoMessage = $state<string | null>(null);
	let busy = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	function fill(v: OrganizationView) {
		view = v;
		const r = v.representative;
		form = {
			legalName: v.legalName,
			tradeName: v.tradeName ?? '',
			address: v.address ?? '',
			commune: v.commune,
			poBox: v.poBox ?? '',
			rccm: v.rccm ?? '',
			ifu: v.ifu ?? '',
			rep: {
				name: r.name ?? '',
				title: r.title ?? '',
				profession: r.profession ?? '',
				address: r.address ?? '',
				nationality: r.nationality ?? '',
				idType: r.idType ?? '',
				idTypeOther: r.idTypeOther ?? '',
				idNumber: r.idNumber ?? '',
				idIssuedOn: r.idIssuedOn ?? '',
				idIssuedBy: r.idIssuedBy ?? ''
			}
		};
		// Numéro burkinabè : affiché sans l'indicatif ; un autre pays reste en entier (« +33… »).
		country = '226';
		phone = v.phone.startsWith('+226') ? v.phone.slice(4) : v.phone;
		watchLogo();
	}

	/** Pendant le traitement du logo (tâche de fond), relecture régulière de la fiche. */
	function watchLogo(attempt = 0) {
		clearTimeout(timer);
		if (view?.logo?.status !== 'processing' || attempt > 40) return;
		timer = setTimeout(async () => {
			const next = await organizations.call<OrganizationView>('GET', '/organization');
			view = next;
			if (next.logo?.status === 'ready') logoMessage = t.logoReady;
			watchLogo(attempt + 1);
		}, 1000);
	}

	onMount(async () => {
		try {
			fill(await organizations.call<OrganizationView>('GET', '/organization'));
		} catch (error) {
			message = messageOf(error);
		}
	});
	onDestroy(() => clearTimeout(timer));

	async function save(event: SubmitEvent) {
		event.preventDefault();
		message = null;
		info = null;
		const number = phoneOf(phone, country);
		const input = {
			legalName: form.legalName,
			tradeName: form.tradeName,
			phone: 'phone' in number ? number.phone : '',
			address: form.address,
			commune: form.commune,
			poBox: form.poBox,
			rccm: form.rccm,
			ifu: form.ifu,
			representative: { ...form.rep, idType: form.rep.idType || null, idIssuedOn: form.rep.idIssuedOn || null }
		};
		const parsed = updateOrganizationSchema.safeParse(input);
		const flat = fieldErrors(parsed.error);
		for (const issue of parsed.error?.issues ?? [])
			if (issue.path[0] === 'representative') flat[`rep.${String(issue.path[1])}`] = issue.message;
		errors = { ...flat, ...('error' in number ? { phone: number.error } : {}) };
		if (!parsed.success || 'error' in number) return;
		busy = true;
		try {
			fill(await organizations.call<OrganizationView>('PATCH', '/organization', input));
			info = t.saved;
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}

	async function upload(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		logoMessage = null;
		if (!file) return;
		if (!(LOGO_MIME_TYPES as readonly string[]).includes(file.type) || file.size > LOGO_MAX_BYTES) {
			logoMessage = t.logoHint;
			return;
		}
		try {
			view = await organizations.call<OrganizationView>('PUT', '/organization/logo', undefined, file);
			logoMessage = t.logoProcessing;
			watchLogo();
		} catch (error) {
			logoMessage = messageOf(error);
		}
	}

	const previewView = $derived<OrganizationView | null>(
		view
			? {
					...view,
					legalName: form.legalName || view.legalName,
					tradeName: form.tradeName || null,
					address: form.address || null,
					commune: form.commune,
					poBox: form.poBox || null,
					rccm: form.rccm ? form.rccm.toUpperCase() : null,
					ifu: form.ifu ? form.ifu.toUpperCase() : null,
					phone: toE164(phone, country) ?? view.phone
				}
			: null
	);
	const field = 'space-y-1';
	const label = 'block font-medium';
	const section = 'space-y-4 rounded-2xl border bg-card p-4 md:p-6';
</script>

<PageHeader title={t.title} subtitle={t.subtitle} />

<main class="page space-y-4 pt-3 pb-10" data-testid="parametres-organisation">
	<FormAlert {message} />
	{#if view}
		{#if !editable}<FormAlert message={t.readOnly} tone="info" />{/if}
		<div class="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_26rem] xl:items-start">
			<form class="space-y-4" onsubmit={save} novalidate>
				<fieldset class={section} disabled={!editable}>
					<legend class="sr-only">{t.identity}</legend>
					<h2 class="text-lg font-semibold">{t.identity}</h2>
					<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
						<div class={field}>
							<label for="raison" class={label}>{t.legalName}</label>
							<Input id="raison" bind:value={form.legalName} aria-invalid={errors.legalName ? 'true' : undefined} />
							{#if errors.legalName}<p class="text-base text-destructive">{errors.legalName}</p>{/if}
						</div>
						<div class={field}>
							<label for="nom-commercial" class={label}>{t.tradeName}</label>
							<Input id="nom-commercial" bind:value={form.tradeName} />
						</div>
					</div>
				</fieldset>

				<fieldset class={section} disabled={!editable}>
					<legend class="sr-only">{t.contact}</legend>
					<h2 class="text-lg font-semibold">{t.contact}</h2>
					<PhoneField
						bind:value={phone}
						bind:country
						error={errors.phone}
						id="telephone-organisation"
						label={t.phone}
						hint={fr.organizations.phoneHint}
					/>
					<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
						<div class={field}>
							<label for="adresse" class={label}>{t.address}</label>
							<Input id="adresse" bind:value={form.address} autocomplete="street-address" />
						</div>
						<div class={field}>
							<label for="commune" class={label}>{t.commune}</label>
							<Input id="commune" bind:value={form.commune} aria-invalid={errors.commune ? 'true' : undefined} />
							{#if errors.commune}<p class="text-base text-destructive">{errors.commune}</p>{/if}
						</div>
						<div class={field}>
							<label for="bp" class={label}>{t.poBox}</label>
							<Input id="bp" bind:value={form.poBox} placeholder="01 BP 1234 Ouagadougou 01" />
						</div>
					</div>
				</fieldset>

				<fieldset class={section} disabled={!editable}>
					<legend class="sr-only">{t.registry}</legend>
					<h2 class="text-lg font-semibold">{t.registry}</h2>
					<p class="text-base text-muted-foreground">{t.registryHint}</p>
					<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
						<div class={field}>
							<label for="rccm" class={label}>{t.rccm}</label>
							<Input id="rccm" bind:value={form.rccm} autocapitalize="characters" />
						</div>
						<div class={field}>
							<label for="ifu" class={label}>{t.ifu}</label>
							<Input id="ifu" bind:value={form.ifu} autocapitalize="characters" />
						</div>
					</div>
				</fieldset>

				<fieldset class={section} disabled={!editable}>
					<legend class="sr-only">{t.representative}</legend>
					<h2 class="text-lg font-semibold">{t.representative}</h2>
					<p class="text-base text-muted-foreground">{t.representativeHint}</p>
					<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
						<div class={field}><label for="rep-nom" class={label}>{t.repName}</label><Input id="rep-nom" bind:value={form.rep.name} /></div>
						<div class={field}>
							<label for="rep-qualite" class={label}>{t.repTitle}</label><Input
								id="rep-qualite"
								bind:value={form.rep.title}
								placeholder={t.repTitlePlaceholder}
							/>
						</div>
						<div class={field}>
							<label for="rep-profession" class={label}>{t.repProfession}</label><Input
								id="rep-profession"
								bind:value={form.rep.profession}
							/>
						</div>
						<div class={field}>
							<label for="rep-nationalite" class={label}>{t.repNationality}</label><Input
								id="rep-nationalite"
								bind:value={form.rep.nationality}
							/>
						</div>
						<div class="{field} md:col-span-2">
							<label for="rep-domicile" class={label}>{t.repAddress}</label><Input id="rep-domicile" bind:value={form.rep.address} />
						</div>
						<div class={field}>
							<label for="rep-piece" class={label}>{t.idType}</label>
							<select
								id="rep-piece"
								bind:value={form.rep.idType}
								class="min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 text-base"
							>
								<option value="">{t.idTypeNone}</option>
								{#each ID_DOCUMENT_TYPES as type (type)}<option value={type}>{ID_DOCUMENT_LABELS[type]}</option>{/each}
							</select>
						</div>
						{#if form.rep.idType === 'other'}
							<div class={field}>
								<label for="rep-piece-autre" class={label}>{t.idTypeOther}</label>
								<Input
									id="rep-piece-autre"
									bind:value={form.rep.idTypeOther}
									aria-invalid={errors['rep.idTypeOther'] ? 'true' : undefined}
								/>
								{#if errors['rep.idTypeOther']}<p class="text-base text-destructive">{errors['rep.idTypeOther']}</p>{/if}
							</div>
						{/if}
						<div class={field}>
							<label for="rep-numero" class={label}>{t.idNumber}</label><Input id="rep-numero" bind:value={form.rep.idNumber} />
						</div>
						<div class={field}>
							<label for="rep-date" class={label}>{t.idIssuedOn}</label><Input id="rep-date" type="date" bind:value={form.rep.idIssuedOn} />
						</div>
						<div class={field}>
							<label for="rep-autorite" class={label}>{t.idIssuedBy}</label><Input id="rep-autorite" bind:value={form.rep.idIssuedBy} />
						</div>
					</div>
				</fieldset>

				{#if editable}
					<FormAlert message={info} tone="info" />
					<Button type="submit" size="lg" class="w-full md:w-auto" disabled={busy}
						><Save aria-hidden="true" />{busy ? fr.auth.submitting : t.save}</Button
					>
				{/if}
			</form>

			<div class="space-y-4">
				<section class={section} aria-labelledby="titre-logo">
					<h2 id="titre-logo" class="text-lg font-semibold">{t.logo}</h2>
					<p class="text-base text-muted-foreground">{t.logoHint}</p>
					{#if view.logo?.status === 'processing'}<p role="status" class="text-base">{t.logoProcessing}</p>{/if}
					{#if view.logo?.status === 'failed'}<p role="alert" class="text-base text-destructive">{t.logoFailed}</p>{/if}
					{#if editable}
						<label
							class="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border-2 border-input bg-card px-4 font-semibold focus-within:ring-[3px] focus-within:ring-ring/50 hover:bg-accent"
						>
							<ImageUp class="size-5" aria-hidden="true" />{view.logo ? t.replaceLogo : t.chooseLogo}
							<input type="file" accept={LOGO_MIME_TYPES.join(',')} class="sr-only" onchange={upload} data-testid="logo-fichier" />
						</label>
					{/if}
					{#if logoMessage}<p role="status" class="text-base" data-testid="logo-message">{logoMessage}</p>{/if}
				</section>
				{#if previewView}<ReceiptHeader organization={previewView} />{/if}
			</div>
		</div>
	{/if}
</main>
