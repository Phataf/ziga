<script lang="ts">
	/**
	 * Assistant de création d'un bail (lot 08, docs/UX.md §10), depuis une unité disponible, en cinq étapes : locataire
	 * (choisir ou créer) ; conditions et paramètres du contrat (D24, valeurs légales par défaut) ; caution, garantie des
	 * factures et détenteur ; avance et aperçu de l'échéancier ; documents (bail scanné, pièce d'identité, en ligne).
	 * Tout s'écrit sur l'appareil, hors connexion aussi : le bail naît brouillon à l'étape 2 et chaque étape l'enregistre ;
	 * on reprend par la fiche du bail (`?bail=<id>&etape=<n>`). « Valider le bail » demande la validation : le serveur
	 * vérifie le mandat et la disponibilité, décide le statut et génère les échéances (aperçu identique en attendant).
	 * Téléphone : une étape par écran ; tablette et ordinateur : étapes à gauche, formulaire à droite.
	 */
	import { onMount } from 'svelte';
	import { ArrowLeft, Check, CheckCircle2, Save } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import type { DocumentView } from '@ziga/shared/documents';
	import { formatDate, toIsoDate } from '@ziga/shared/dates';
	import { newId } from '@ziga/shared/ids';
	import {
		allowedDepositHolders,
		allowedLessorTypes,
		createDepositAccountSchema,
		createLeaseSchema,
		createTenantSchema,
		defaultDepositHolder,
		depositAboveLegalCap,
		LEGAL_LEASE_DEFAULTS,
		leaseTermsSchema,
		RENEWAL_MODES,
		tenantIdentitySchema,
		type DepositHolder,
		type LeaseView,
		type TenantView
	} from '@ziga/shared/leases';
	import { formatFcfa, parseFcfa } from '@ziga/shared/money';
	import { ID_DOCUMENT_LABELS, ID_DOCUMENT_TYPES } from '@ziga/shared/organizations';
	import { can } from '@ziga/shared/permissions';
	import type { UnitView } from '@ziga/shared/properties';
	import { RENT_BILLING_MODES, type RentBillingMode } from '@ziga/shared/rent-schedule';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import DocumentsSection from '#lib/components/properties/DocumentsSection.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { previewSchedule, toLease, toTenant } from '#lib/leases/views.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { toMandate } from '#lib/owners/views.ts';
	import { toDocument, toUnit } from '#lib/properties/views.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';
	import {
		createDepositAccount,
		createLeaseDraft,
		createTenant,
		requestLeaseValidation,
		saveDepositAgreed,
		saveLeaseDraft
	} from '#lib/sync/writes.ts';

	type Row = Record<string, unknown>;
	const t = fr.leases;
	const w = t.wizard;
	const tt = fr.tenants;
	const STEPS = 5;
	const today = toIsoDate();
	const select = 'min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 text-base';
	const field = 'space-y-1';
	const labelClass = 'block font-medium';

	const role = $derived(organizations.active?.role);
	const orgType = $derived(organizations.active?.type ?? 'agency');
	const allowed = $derived(can(role, 'lease.create'));
	const leaseId = $derived(page.url.searchParams.get('bail'));
	const unitParam = $derived(page.url.searchParams.get('unite'));
	const tenantParam = $derived(page.url.searchParams.get('locataire'));
	const step = $derived(Math.min(STEPS, Math.max(1, Number(page.url.searchParams.get('etape') ?? 1) || 1)));

	let units = $state<UnitView[]>([]);
	let tenants = $state<TenantView[]>([]);
	let leaseRow = $state<Row | null>(null);
	let accountRows = $state<Row[]>([]);
	let scopeRows = $state<Row[]>([]);
	let mandates = $state<ReturnType<typeof toMandate>[]>([]);
	let documents = $state<DocumentView[]>([]);
	let orgMode = $state<RentBillingMode>('calendar_prorata');
	let message = $state<string | null>(null);
	let errors = $state<Record<string, string>>({});
	let busy = $state(false);

	// Étape 1
	let unitChoice = $state('');
	let tenantChoice = $state('');
	let tf = $state<Record<string, string>>({});
	// Étape 2
	let c = $state<Record<string, string>>({});
	let filled = false;
	// Étape 3
	let depositAmount = $state('');
	let depositMonths = $state('');
	let holder = $state<DepositHolder | ''>('');
	let utilities = $state('');
	// Étape 4
	let advance = $state('');

	onMount(() => {
		const org = organizations.activeId;
		const onError = (error: Error) => (message = messageOf(error));
		const stops = [
			sync.watch<Row>(LOCAL_QUERIES.units, [org], (rows) => (units = rows.map((r) => toUnit(r))), onError),
			sync.watch<Row>(LOCAL_QUERIES.tenants, [org], (rows) => (tenants = rows.map(toTenant).filter((x) => x.status === 'active')), onError),
			sync.watch<Row>(
				LOCAL_QUERIES.organization,
				[org],
				(rows) => (orgMode = (rows[0]?.rent_billing_mode as RentBillingMode) ?? 'calendar_prorata')
			),
			sync.watch<Row>(LOCAL_QUERIES.mandates, [org], (rows) => (mandates = rows.map(toMandate)), onError)
		];
		return () => stops.forEach((stop) => stop());
	});

	// Le brouillon, ses comptes de caution et ses documents, dès qu'il existe.
	$effect(() => {
		const org = organizations.activeId;
		const id = leaseId;
		if (!id) return;
		const stops = [
			sync.watch<Row>(LOCAL_QUERIES.lease, [org, id], (rows) => {
				leaseRow = rows[0] ?? null;
				if (leaseRow && !filled) fill(toLease(leaseRow));
			}),
			sync.watch<Row>(LOCAL_QUERIES.leaseDeposits, [org, id], (rows) => (accountRows = rows))
		];
		return () => stops.forEach((stop) => stop());
	});

	const lease = $derived(leaseRow ? toLease(leaseRow) : null);
	const unitId = $derived(lease?.unitId ?? unitParam ?? (unitChoice || null));
	const unit = $derived(units.find((u) => u.id === unitId) ?? null);
	const tenantId = $derived(lease?.tenantId ?? tenantParam);
	const tenant = $derived(tenants.find((x) => x.id === tenantId) ?? null);
	// Une unité « disponible » au sens de la règle 13 (le serveur le vérifie de nouveau).
	const availableUnits = $derived(units.filter((u) => u.available));

	// Portées de l'unité (détenteur proposé selon le mandat) et documents du brouillon.
	$effect(() => {
		const org = organizations.activeId;
		const propertyId = unit?.propertyId;
		if (!propertyId) return;
		return sync.watch<Row>(LOCAL_QUERIES.propertyAllScopes, [org, propertyId], (rows) => (scopeRows = rows));
	});
	$effect(() => {
		const org = organizations.activeId;
		if (!leaseId || !tenantId || !can(role, 'document.read')) return;
		return sync.watch<Row>(LOCAL_QUERIES.leaseDocuments, [org, leaseId, tenantId], (rows) => (documents = rows.map(toDocument)));
	});

	/** Le mandat de gestion qui couvre l'unité autorise-t-il l'organisation à encaisser ? */
	const canCollect = $derived.by(() => {
		const scope = scopeRows.find((s) => s.unit_id === unitId && (s.management_active === 1 || s.management_active === true));
		return !!mandates.find((m) => m.id === scope?.mandate_id)?.canCollectFunds;
	});
	const proposedHolder = $derived(defaultDepositHolder(orgType, canCollect));
	const holders = $derived(allowedDepositHolders(orgType));
	const lessors = $derived(allowedLessorTypes(orgType));

	function fill(l: LeaseView) {
		filled = true;
		c = {
			startsOn: l.startsOn,
			durationMonths: l.durationMonths ? String(l.durationMonths) : '',
			duesStartOn: l.duesStartOn !== l.startsOn ? l.duesStartOn : '',
			rent: String(l.rent),
			charges: String(l.charges),
			dueDay: String(l.dueDay),
			billingMode: l.billingMode,
			lessorType: l.lessorType,
			paymentTerms: l.paymentTerms ?? '',
			noticeTenantFixedTermMonths: String(l.noticeTenantFixedTermMonths),
			noticeTenantOpenEndedMonths: String(l.noticeTenantOpenEndedMonths),
			noticeLessorFixedTermMonths: String(l.noticeLessorFixedTermMonths),
			noticeLessorOpenEndedMonths: String(l.noticeLessorOpenEndedMonths),
			renewalMode: l.renewalMode,
			depositRefundDays: String(l.depositRefundDays),
			penaltyRate: l.penaltyRateBp ? String(l.penaltyRateBp / 100) : '',
			penaltyGraceDays: l.penaltyGraceDays !== null ? String(l.penaltyGraceDays) : '',
			penaltyBeneficiary: l.penaltyBeneficiary ?? ''
		};
		advance = String(l.advanceMonths);
	}

	// Valeurs proposées pour un nouveau bail : celles de l'unité et du réglage de l'organisation.
	$effect(() => {
		if (filled || leaseId || !unit || c.rent !== undefined) return;
		c = {
			startsOn: today,
			durationMonths: '12',
			duesStartOn: '',
			rent: unit.rent ? String(unit.rent) : '',
			charges: unit.charges ? String(unit.charges) : '0',
			dueDay: String(LEGAL_LEASE_DEFAULTS.dueDay),
			billingMode: orgMode,
			lessorType: lessors[0]!,
			paymentTerms: '',
			noticeTenantFixedTermMonths: String(LEGAL_LEASE_DEFAULTS.noticeTenantFixedTermMonths),
			noticeTenantOpenEndedMonths: String(LEGAL_LEASE_DEFAULTS.noticeTenantOpenEndedMonths),
			noticeLessorFixedTermMonths: String(LEGAL_LEASE_DEFAULTS.noticeLessorFixedTermMonths),
			noticeLessorOpenEndedMonths: String(LEGAL_LEASE_DEFAULTS.noticeLessorOpenEndedMonths),
			renewalMode: LEGAL_LEASE_DEFAULTS.renewalMode,
			depositRefundDays: String(LEGAL_LEASE_DEFAULTS.depositRefundDays),
			penaltyRate: '',
			penaltyGraceDays: '',
			penaltyBeneficiary: ''
		};
		advance = unit.advanceMonths !== null ? String(unit.advanceMonths) : '0';
	});

	// Étape 3 : montants existants du brouillon, ou ceux de l'unité.
	$effect(() => {
		if (step !== 3 || depositAmount || !lease) return;
		const sec = accountRows.find((a) => a.type === 'security_deposit');
		const util = accountRows.find((a) => a.type === 'utilities_guarantee');
		depositAmount = sec ? String(sec.agreed_amount) : unit?.depositAmount ? String(unit.depositAmount) : '';
		depositMonths = sec?.agreed_months ? String(sec.agreed_months) : '';
		utilities = util ? String(util.agreed_amount) : '';
		holder = (sec?.holder as DepositHolder) ?? proposedHolder;
	});

	async function db() {
		return sync.db ?? (await sync.start());
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

	function issues(error: { issues: { path: PropertyKey[]; message: string }[] }): Record<string, string> {
		const out: Record<string, string> = {};
		for (const i of error.issues) out[String(i.path[0] ?? '')] ??= i.message;
		return out;
	}

	/** Champ texte vide : null. `bind:value` d'un champ `type="number"` donne un nombre, ou une chaîne vide. */
	const blank = (v: unknown) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
	const num = (v: unknown) => (blank(v) === null ? null : Number(v));

	async function go(n: number) {
		await goto(resolve(`/app/baux/assistant?bail=${leaseId}&etape=${n}`));
	}

	// ---------------------------------------------------------------- étape 1 : locataire

	async function saveStep1(event: SubmitEvent) {
		event.preventDefault();
		const org = organizations.activeId;
		if (!org) return;
		const chosenUnit = unitParam ?? unitChoice;
		if (!chosenUnit) return void (errors = { unit: w.unitRequired });
		await run(async () => {
			let id = tenantChoice;
			if (!id) {
				const parsed = createTenantSchema.safeParse({
					id: newId(),
					civility: blank(tf.civility),
					fullName: tf.fullName ?? '',
					phone: blank(tf.phone),
					profession: blank(tf.profession),
					nationality: blank(tf.nationality)
				});
				const ident = tenantIdentitySchema.safeParse({
					birthDate: blank(tf.birthDate),
					birthPlace: blank(tf.birthPlace),
					idType: blank(tf.idType),
					idTypeOther: blank(tf.idTypeOther),
					idNumber: blank(tf.idNumber),
					idIssuedOn: blank(tf.idIssuedOn),
					idIssuedBy: blank(tf.idIssuedBy)
				});
				if (!parsed.success || !ident.success) {
					errors = { ...(parsed.success ? {} : issues(parsed.error)), ...(ident.success ? {} : issues(ident.error)) };
					if (!tf.fullName) errors.fullName ??= w.tenantRequired;
					return;
				}
				await createTenant(await db(), org, parsed.data, can(role, 'tenant.read_identity') ? ident.data : null);
				id = parsed.data.id;
			}
			errors = {};
			await goto(resolve(`/app/baux/assistant?unite=${chosenUnit}&locataire=${id}&etape=2`));
		});
	}

	// ---------------------------------------------------------------- étape 2 : conditions

	function terms() {
		const rate = blank(c.penaltyRate);
		return {
			startsOn: c.startsOn,
			durationMonths: num(c.durationMonths),
			endsOn: null,
			duesStartOn: blank(c.duesStartOn),
			rent: parseFcfa(c.rent ?? '') ?? NaN,
			charges: parseFcfa(c.charges ?? '0') ?? NaN,
			dueDay: num(c.dueDay) ?? undefined,
			billingMode: c.billingMode as RentBillingMode,
			advanceMonths: num(advance) ?? 0,
			lessorType: c.lessorType,
			paymentTerms: blank(c.paymentTerms),
			penaltyRateBp: rate ? Math.round(Number(rate.replace(',', '.')) * 100) : null,
			penaltyGraceDays: rate ? (num(c.penaltyGraceDays) ?? 0) : null,
			penaltyBeneficiary: rate ? blank(c.penaltyBeneficiary) : null,
			noticeTenantFixedTermMonths: num(c.noticeTenantFixedTermMonths) ?? undefined,
			noticeTenantOpenEndedMonths: num(c.noticeTenantOpenEndedMonths) ?? undefined,
			noticeLessorFixedTermMonths: num(c.noticeLessorFixedTermMonths) ?? undefined,
			noticeLessorOpenEndedMonths: num(c.noticeLessorOpenEndedMonths) ?? undefined,
			renewalMode: c.renewalMode,
			depositRefundDays: num(c.depositRefundDays) ?? undefined
		};
	}

	async function saveStep2(event: SubmitEvent) {
		event.preventDefault();
		const org = organizations.activeId;
		if (!org || !unitId || !tenantId) return;
		await run(async () => {
			if (leaseId) {
				const parsed = leaseTermsSchema.safeParse(terms());
				if (!parsed.success) return void (errors = issues(parsed.error));
				errors = {};
				await saveLeaseDraft(await db(), org, leaseId, parsed.data);
				await go(3);
				return;
			}
			const parsed = createLeaseSchema.safeParse({ id: newId(), unitId, tenantId, validate: false, ...terms() });
			if (!parsed.success) return void (errors = issues(parsed.error));
			errors = {};
			await createLeaseDraft(await db(), org, { ...parsed.data, billingMode: parsed.data.billingMode ?? orgMode });
			await goto(resolve(`/app/baux/assistant?bail=${parsed.data.id}&etape=3`));
		});
	}

	// ---------------------------------------------------------------- étape 3 : caution

	const depositValue = $derived(parseFcfa(depositAmount || '0'));
	const aboveCap = $derived(!!lease && depositValue !== null && depositAboveLegalCap('security_deposit', depositValue, lease.rent));

	async function saveStep3(event: SubmitEvent) {
		event.preventDefault();
		const org = organizations.activeId;
		if (!org || !lease) return;
		await run(async () => {
			const database = await db();
			const errs: Record<string, string> = {};
			const plan: (() => Promise<void>)[] = [];
			for (const [type, value, months] of [
				['security_deposit', depositAmount, depositMonths],
				['utilities_guarantee', utilities, '']
			] as const) {
				if (!value.trim()) continue;
				const existing = accountRows.find((a) => a.type === type);
				const amount = parseFcfa(value);
				if (existing) {
					if (amount === null) errs[type] = t.amountInvalid;
					else plan.push(() => saveDepositAgreed(database, org, String(existing.id), amount, num(months)));
					continue;
				}
				const parsed = createDepositAccountSchema.safeParse({
					id: newId(),
					leaseId: lease.id,
					type,
					agreedAmount: amount,
					agreedMonths: num(months),
					holder: holder || undefined
				});
				if (!parsed.success) Object.assign(errs, { [type]: parsed.error.issues[0]!.message });
				else {
					plan.push(() => createDepositAccount(database, org, parsed.data));
				}
			}
			errors = errs;
			if (Object.keys(errs).length) return;
			for (const p of plan) await p();
			await go(4);
		});
	}

	// ---------------------------------------------------------------- étape 4 : avance et échéancier

	const preview = $derived(lease ? previewSchedule({ ...lease, advanceMonths: num(advance) ?? 0 }, today) : []);

	async function saveStep4(event: SubmitEvent) {
		event.preventDefault();
		const org = organizations.activeId;
		if (!org || !lease || !leaseId) return;
		await run(async () => {
			const parsed = leaseTermsSchema.safeParse({ ...lease, advanceMonths: num(advance) ?? 0 });
			if (!parsed.success) return void (errors = issues(parsed.error));
			errors = {};
			await saveLeaseDraft(await db(), org, leaseId, parsed.data);
			await go(5);
		});
	}

	// ---------------------------------------------------------------- étape 5 : documents et validation

	async function finish(validate: boolean) {
		const org = organizations.activeId;
		if (!org || !lease) return;
		await run(async () => {
			if (validate) await requestLeaseValidation(await db(), org, lease.id, lease.startsOn, today);
			// Lot 09 : à la signature, la caution et l'avance s'encaissent en une seule saisie, avec leurs reçus (point 4).
			if (validate && can(organizations.active?.role, 'payment.record')) {
				const objet = accountRows.some((a) => a.type === 'security_deposit') ? 'signature' : 'loyer';
				await goto(resolve(`/app/encaisser?bail=${lease.id}&objet=${objet}`));
				return;
			}
			await goto(resolve('/app/baux/[id]', { id: lease.id }));
		});
	}
</script>

<PageHeader
	title={unit ? w.resumeTitle(unit.label) : w.title}
	subtitle={`${w.step(step, STEPS)} · ${w.steps[step - 1]}`}
	back="app/locataires"
	backLabel={fr.tenants.back}
/>

<main class="page pt-3 pb-10" data-testid="assistant-bail" data-etape={step}>
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
								{#if leaseId && n >= 2}
									<a
										href={resolve(`/app/baux/assistant?bail=${leaseId}&etape=${n}`)}
										class="flex min-h-11 items-center gap-2 rounded-lg px-3 text-base {n === step
											? 'bg-accent font-semibold'
											: 'text-muted-foreground'}"
										aria-current={n === step ? 'step' : undefined}
									>
										{#if n < step}<Check class="size-4" aria-hidden="true" />{:else}<span class="w-4 text-center">{n}</span>{/if}{label}
									</a>
								{:else}
									<span class="flex min-h-11 items-center gap-2 px-3 text-base {n === step ? 'font-semibold' : 'text-muted-foreground'}"
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
				{#if leaseId}<FormAlert message={w.draftSaved} tone="info" />{/if}

				{#if leaseId && !lease}
					<p class="text-base text-muted-foreground" role="status" data-testid="chargement">{fr.app.loading}</p>
				{:else if step === 1}
					<form class="space-y-4 rounded-2xl border bg-card p-4 md:p-6" onsubmit={saveStep1} novalidate data-testid="etape-1">
						{#if unitParam}
							<p class="text-base"><strong>{w.chooseUnit} :</strong> {unit?.label ?? ''}</p>
							{#if unit && !unit.available}<FormAlert message={w.unitNotAvailable} tone="info" />{/if}
						{:else}
							<div class={field}>
								<label for="unite" class={labelClass}>{w.chooseUnit}</label>
								<select id="unite" bind:value={unitChoice} class={select}>
									<option value="">{w.chooseUnitPlaceholder}</option>
									{#each availableUnits as u (u.id)}<option value={u.id}>{u.label}</option>{/each}
								</select>
								{#if !availableUnits.length}<p class="text-sm text-muted-foreground">{w.noUnit}</p>{/if}
								{#if errors.unit}<p class="text-base text-destructive">{errors.unit}</p>{/if}
							</div>
						{/if}
						<div class={field}>
							<label for="locataire-existant" class={labelClass}>{w.existing}</label>
							<select id="locataire-existant" bind:value={tenantChoice} class={select}>
								<option value="">{w.existingPlaceholder}</option>
								{#each tenants as x (x.id)}<option value={x.id}>{x.fullName}</option>{/each}
							</select>
						</div>
						{#if !tenantChoice}
							<fieldset class="space-y-3 rounded-xl border p-4">
								<legend class="px-1 font-semibold">{w.orNew}</legend>
								<div class="grid gap-4 sm:grid-cols-2">
									<div class={field}>
										<label for="civilite" class={labelClass}>{tt.civility}</label>
										<select id="civilite" bind:value={tf.civility} class={select}>
											<option value=""></option>
											{#each Object.entries(tt.civilities) as [k, label] (k)}<option value={k}>{label}</option>{/each}
										</select>
									</div>
									<div class={field}>
										<label for="nom-locataire" class={labelClass}>{tt.name}</label>
										<Input
											id="nom-locataire"
											bind:value={tf.fullName}
											autocomplete="off"
											aria-invalid={errors.fullName ? 'true' : undefined}
										/>
										{#if errors.fullName}<p class="text-base text-destructive">{errors.fullName}</p>{/if}
									</div>
									<div class={field}>
										<label for="tel-locataire" class={labelClass}>{tt.phone}</label>
										<Input
											id="tel-locataire"
											type="tel"
											inputmode="tel"
											bind:value={tf.phone}
											aria-invalid={errors.phone ? 'true' : undefined}
										/>
										{#if errors.phone}<p class="text-base text-destructive">{errors.phone}</p>{/if}
									</div>
									<div class={field}>
										<label for="profession" class={labelClass}>{tt.profession}</label>
										<Input id="profession" bind:value={tf.profession} />
									</div>
								</div>
								{#if can(role, 'tenant.read_identity')}
									<details class="rounded-xl border p-3">
										<summary class="min-h-11 cursor-pointer content-center font-medium">{w.identityOptional}</summary>
										<div class="mt-3 grid gap-4 sm:grid-cols-2">
											<div class={field}>
												<label for="naissance" class={labelClass}>{tt.birthDate}</label><Input
													id="naissance"
													type="date"
													bind:value={tf.birthDate}
												/>
											</div>
											<div class={field}>
												<label for="lieu-naissance" class={labelClass}>{tt.birthPlace}</label><Input
													id="lieu-naissance"
													bind:value={tf.birthPlace}
												/>
											</div>
											<div class={field}>
												<label for="type-piece" class={labelClass}>{tt.idType}</label>
												<select id="type-piece" bind:value={tf.idType} class={select}>
													<option value=""></option>
													{#each ID_DOCUMENT_TYPES as v (v)}<option value={v}>{ID_DOCUMENT_LABELS[v]}</option>{/each}
												</select>
											</div>
											{#if tf.idType === 'other'}
												<div class={field}>
													<label for="type-piece-autre" class={labelClass}>{tt.idTypeOther}</label><Input
														id="type-piece-autre"
														bind:value={tf.idTypeOther}
													/>
													{#if errors.idTypeOther}<p class="text-base text-destructive">{errors.idTypeOther}</p>{/if}
												</div>
											{/if}
											<div class={field}>
												<label for="numero-piece" class={labelClass}>{tt.idNumber}</label><Input
													id="numero-piece"
													bind:value={tf.idNumber}
												/>
											</div>
											<div class={field}>
												<label for="piece-delivree" class={labelClass}>{tt.idIssuedOn}</label><Input
													id="piece-delivree"
													type="date"
													bind:value={tf.idIssuedOn}
												/>
											</div>
										</div>
									</details>
								{/if}
							</fieldset>
						{/if}
						<Button type="submit" size="lg" class="w-full md:w-auto" disabled={busy}><Save aria-hidden="true" />{w.next}</Button>
					</form>
				{:else if step === 2}
					<form class="space-y-4 rounded-2xl border bg-card p-4 md:p-6" onsubmit={saveStep2} novalidate data-testid="etape-2">
						{#if tenant}<p class="text-base"><strong>{t.tenant} :</strong> {tenant.fullName}</p>{/if}
						<div class="grid gap-4 sm:grid-cols-2">
							<div class={field}>
								<label for="debut" class={labelClass}>{t.start}</label>
								<Input id="debut" type="date" bind:value={c.startsOn} aria-invalid={errors.startsOn ? 'true' : undefined} />
								{#if errors.startsOn}<p class="text-base text-destructive">{errors.startsOn}</p>{/if}
							</div>
							<div class={field}>
								<label for="duree" class={labelClass}>{t.duration}</label>
								<Input id="duree" type="number" inputmode="numeric" min="1" bind:value={c.durationMonths} />
								<p class="text-sm text-muted-foreground">{t.durationHint}</p>
								{#if errors.endsOn}<p class="text-base text-destructive">{errors.endsOn}</p>{/if}
							</div>
							<div class={field}>
								<label for="loyer" class={labelClass}>{t.rent}</label>
								<Input id="loyer" inputmode="numeric" bind:value={c.rent} aria-invalid={errors.rent ? 'true' : undefined} />
								{#if errors.rent}<p class="text-base text-destructive">{errors.rent}</p>{/if}
							</div>
							<div class={field}>
								<label for="charges" class={labelClass}>{t.charges}</label>
								<Input id="charges" inputmode="numeric" bind:value={c.charges} aria-invalid={errors.charges ? 'true' : undefined} />
								{#if errors.charges}<p class="text-base text-destructive">{errors.charges}</p>{/if}
							</div>
							<div class={field}>
								<label for="decoupage" class={labelClass}>{t.billingMode}</label>
								<select id="decoupage" bind:value={c.billingMode} class={select}>
									{#each RENT_BILLING_MODES as m (m)}<option value={m}>{t.billingModes[m]}</option>{/each}
								</select>
							</div>
							{#if c.billingMode !== 'anniversary'}
								<div class={field}>
									<label for="jour" class={labelClass}>{t.dueDay}</label>
									<Input id="jour" type="number" inputmode="numeric" min="1" max="28" bind:value={c.dueDay} />
									<p class="text-sm text-muted-foreground">{t.dueDayHint}</p>
									{#if errors.dueDay}<p class="text-base text-destructive">{errors.dueDay}</p>{/if}
								</div>
							{/if}
							<div class={field}>
								<label for="bailleur" class={labelClass}>{t.lessor}</label>
								<select id="bailleur" bind:value={c.lessorType} class={select}>
									{#each lessors as l (l)}<option value={l}>{t.lessors[l]}</option>{/each}
								</select>
							</div>
						</div>
						<details class="rounded-xl border p-3">
							<summary class="min-h-11 cursor-pointer content-center font-medium">{t.duesStart}</summary>
							<p class="mt-2 text-sm text-muted-foreground">{t.duesStartHint}</p>
							<Input id="premiere-facturation" type="date" bind:value={c.duesStartOn} aria-label={t.duesStart} />
							{#if errors.duesStartOn}<p class="text-base text-destructive">{errors.duesStartOn}</p>{/if}
						</details>
						<details class="rounded-xl border p-3">
							<summary class="min-h-11 cursor-pointer content-center font-medium">{t.parameters}</summary>
							<p class="mt-2 text-sm text-muted-foreground">{t.parametersHint}</p>
							<div class="mt-3 grid gap-4 sm:grid-cols-2">
								{#each [['noticeTenantFixedTermMonths', t.noticeTenantFixed], ['noticeTenantOpenEndedMonths', t.noticeTenantOpen], ['noticeLessorFixedTermMonths', t.noticeLessorFixed], ['noticeLessorOpenEndedMonths', t.noticeLessorOpen], ['depositRefundDays', t.refundDays]] as [k, label] (k)}
									<div class={field}>
										<label for={`p-${k}`} class={labelClass}>{label}</label><Input
											id={`p-${k}`}
											type="number"
											inputmode="numeric"
											min="0"
											bind:value={c[k!]}
										/>
									</div>
								{/each}
								<div class={field}>
									<label for="reconduction" class={labelClass}>{t.renewal}</label>
									<select id="reconduction" bind:value={c.renewalMode} class={select}>
										{#each RENEWAL_MODES as m (m)}<option value={m}>{t.renewals[m]}</option>{/each}
									</select>
								</div>
								<div class={field}>
									<label for="modalites" class={labelClass}>{t.paymentTerms}</label><Input id="modalites" bind:value={c.paymentTerms} />
								</div>
								<div class={field}>
									<label for="penalite" class={labelClass}>{t.penaltyRate}</label>
									<Input id="penalite" inputmode="decimal" bind:value={c.penaltyRate} placeholder={t.penaltyNone} />
									{#if errors.penaltyRateBp}<p class="text-base text-destructive">{errors.penaltyRateBp}</p>{/if}
								</div>
								{#if c.penaltyRate}
									<div class={field}>
										<label for="grace" class={labelClass}>{t.penaltyGrace}</label><Input
											id="grace"
											type="number"
											inputmode="numeric"
											min="0"
											bind:value={c.penaltyGraceDays}
										/>
									</div>
									<div class={field}>
										<label for="beneficiaire" class={labelClass}>{t.penaltyBeneficiary}</label>
										<select id="beneficiaire" bind:value={c.penaltyBeneficiary} class={select}>
											<option value=""></option>
											{#each Object.entries(t.beneficiaries) as [k, label] (k)}<option value={k}>{label}</option>{/each}
										</select>
									</div>
								{/if}
							</div>
						</details>
						<div class="flex flex-wrap gap-2">
							{#if !leaseId}
								<Button type="button" variant="outline" href={resolve(`/app/baux/assistant?unite=${unitId}&etape=1`)}
									><ArrowLeft aria-hidden="true" />{w.previous}</Button
								>
							{/if}
							<Button type="submit" disabled={busy}><Save aria-hidden="true" />{w.next}</Button>
						</div>
					</form>
				{:else if step === 3 && lease}
					<form class="space-y-4 rounded-2xl border bg-card p-4 md:p-6" onsubmit={saveStep3} novalidate data-testid="etape-3">
						<div class="grid gap-4 sm:grid-cols-2">
							<div class={field}>
								<label for="caution" class={labelClass}>{t.depositTypes.security_deposit} · {t.agreed}</label>
								<Input
									id="caution"
									inputmode="numeric"
									bind:value={depositAmount}
									aria-invalid={errors.security_deposit ? 'true' : undefined}
								/>
								{#if errors.security_deposit}<p class="text-base text-destructive">{errors.security_deposit}</p>{/if}
							</div>
							<div class={field}>
								<label for="caution-mois" class={labelClass}>{t.months}</label>
								<Input id="caution-mois" type="number" inputmode="numeric" min="1" max="24" bind:value={depositMonths} />
							</div>
							<div class={field}>
								<label for="detenteur" class={labelClass}>{t.holder}</label>
								<select id="detenteur" bind:value={holder} class={select}>
									{#each holders as h (h)}<option value={h}>{t.holders[h]}</option>{/each}
								</select>
								<p class="text-sm text-muted-foreground">{t.holderProposed}</p>
							</div>
							<div class={field}>
								<label for="garantie" class={labelClass}>{t.depositTypes.utilities_guarantee}</label>
								<Input id="garantie" inputmode="numeric" bind:value={utilities} />
								{#if errors.utilities_guarantee}<p class="text-base text-destructive">{errors.utilities_guarantee}</p>{/if}
							</div>
						</div>
						{#if aboveCap}<FormAlert message={t.aboveCap} tone="info" />{/if}
						<div class="flex flex-wrap gap-2">
							<Button type="button" variant="outline" onclick={() => go(2)}><ArrowLeft aria-hidden="true" />{w.previous}</Button>
							<Button type="submit" disabled={busy}><Save aria-hidden="true" />{w.next}</Button>
						</div>
					</form>
				{:else if step === 4 && lease}
					<form class="space-y-4 rounded-2xl border bg-card p-4 md:p-6" onsubmit={saveStep4} novalidate data-testid="etape-4">
						<div class={field}>
							<label for="avance" class={labelClass}>{t.advance}</label>
							<Input id="avance" type="number" inputmode="numeric" min="0" max="24" bind:value={advance} />
							<p class="text-sm text-muted-foreground">{t.advanceHint}</p>
							{#if errors.advanceMonths}<p class="text-base text-destructive">{errors.advanceMonths}</p>{/if}
						</div>
						<FormAlert message={t.preview} tone="info" />
						<ul class="divide-y rounded-xl border" data-testid="apercu-echeancier">
							{#each preview as d (d.periodStart)}
								<li class="flex flex-wrap items-center justify-between gap-2 p-3 text-base" data-testid="echeance-apercu">
									<span
										>{formatDate(d.periodStart)} → {formatDate(d.periodEnd)}{d.isAdvance ? ` · ${t.advanceDue}` : ''}{d.prorated
											? ` · ${t.prorated}`
											: ''}</span
									>
									<span class="tabular-nums">{formatDate(d.dueOn)} · {formatFcfa(d.amountDue)}</span>
								</li>
							{/each}
						</ul>
						<div class="flex flex-wrap gap-2">
							<Button type="button" variant="outline" onclick={() => go(3)}><ArrowLeft aria-hidden="true" />{w.previous}</Button>
							<Button type="submit" disabled={busy}><Save aria-hidden="true" />{w.next}</Button>
						</div>
					</form>
				{:else if step === 5 && lease}
					<div class="space-y-4" data-testid="etape-5">
						{#if can(role, 'document.upload') && sync.online}
							<DocumentsSection leaseId={lease.id} tenantId={lease.tenantId} {documents} disabled={sync.pending > 0} />
						{:else}
							<FormAlert message={t.documentsOnline} tone="info" />
						{/if}
						<p class="text-sm text-muted-foreground">{t.validateHint}</p>
						<div class="flex flex-wrap gap-2">
							<Button variant="outline" onclick={() => go(4)}><ArrowLeft aria-hidden="true" />{w.previous}</Button>
							<Button variant="outline" disabled={busy} onclick={() => finish(false)}>{w.finishDraft}</Button>
							<Button disabled={busy} onclick={() => finish(true)} data-testid="valider"
								><CheckCircle2 aria-hidden="true" />{w.finish}</Button
							>
						</div>
					</div>
				{/if}
			</section>
		</div>
	{/if}
</main>
