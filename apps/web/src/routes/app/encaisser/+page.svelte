<script lang="ts">
	/**
	 * Encaisser (lot 09), en 3 gestes et hors ligne (docs/UX.md §4) : 1. trouver le locataire (nom, téléphone ou
	 * logement, sur l'appareil) ; 2. vérifier le montant, pré-rempli avec le reste dû moins ce qui attend déjà
	 * validation ; choisir le moyen (et la référence d'un Mobile Money) ; 3. « Valider 85 000 FCFA » → le reçu.
	 * Tout est lu et écrit sur l'appareil ; le serveur décide du statut, impute et numérote à la confirmation.
	 * « Caution et avance » à la signature : une seule saisie, deux encaissements et deux reçus.
	 * Téléphone : liste puis formulaire, bouton de validation sous le pouce. Tablette en paysage et ordinateur : liste et
	 * formulaire côte à côte ; sur ordinateur, on tape un nom puis Entrée.
	 */
	import { onMount, tick } from 'svelte';
	import { ArrowLeft, Banknote, Building, Check, Search, Smartphone } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { toIsoDate } from '@ziga/shared/dates';
	import { newId } from '@ziga/shared/ids';
	import { outstandingBalance } from '@ziga/shared/leases';
	import { formatFcfa, parseFcfa } from '@ziga/shared/money';
	import {
		duplicateMobileMoneyPayment,
		MOBILE_MONEY_OPERATORS,
		newReceiptToken,
		paymentEntriesSchema,
		provisionalReceiptNumber,
		selectablePaymentMethods,
		type MobileMoneyOperator,
		type PaymentEntryInput
	} from '@ziga/shared/payments';
	import type { PaymentMethod } from '@ziga/shared/organizations';
	import { can } from '@ziga/shared/permissions';
	import { formatPhone } from '@ziga/shared/phone';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import FeatureGate from '#lib/components/FeatureGate.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { toDepositAccount, toMovement, toRentDue } from '#lib/leases/views.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import {
		pendingRentAmount,
		searchTargets,
		suggestedRentAmount,
		toPayment,
		toTarget,
		type DueForScreen,
		type LocalPayment,
		type PaymentTarget
	} from '#lib/payments/views.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';
	import { jsonArray } from '#lib/sync/views.ts';
	import { recordPayments } from '#lib/sync/writes.ts';
	import { cn } from '#lib/utils.ts';

	type Row = Record<string, unknown>;
	type Purpose = 'rent' | 'deposit' | 'both';
	const t = fr.payments;
	const today = toIsoDate();
	const role = $derived(organizations.active?.role);
	const canCollect = $derived(can(role, 'payment.record_cash'));
	const canDeposit = $derived(can(role, 'payment.record') && can(role, 'deposit.read'));

	let targets = $state<PaymentTarget[]>([]);
	let payments = $state<LocalPayment[]>([]);
	let accepted = $state<PaymentMethod[]>([]);
	let dueRows = $state<Row[]>([]);
	let accountRows = $state<Row[]>([]);
	let movementRows = $state<Row[]>([]);
	let leaseRow = $state<Row | null>(null);

	let query = $state('');
	let leaseId = $state<string | null>(page.url.searchParams.get('bail'));
	/** Ouvert par l'assistant après la validation du bail : « Plus tard » revient à la fiche du bail. */
	const signedLease = page.url.searchParams.get('objet') === 'signature' ? page.url.searchParams.get('bail') : null;
	let purpose = $state<Purpose>(
		page.url.searchParams.get('objet') === 'caution' ? 'deposit' : page.url.searchParams.get('objet') === 'signature' ? 'both' : 'rent'
	);
	let amount = $state('');
	let depositAmount = $state('');
	let method = $state<PaymentMethod | null>(null);
	let operator = $state<MobileMoneyOperator | null>(null);
	let reference = $state('');
	let paidOn = $state(today);
	let message = $state<string | null>(null);
	let busy = $state(false);
	let touched = $state(false);

	onMount(() => {
		if (!canCollect) return;
		const org = organizations.activeId;
		const onError = (error: Error) => (message = messageOf(error));
		const stops = [
			sync.watch<Row>(LOCAL_QUERIES.paymentTargets, [org], (rows) => (targets = rows.map(toTarget)), onError),
			sync.watch<Row>(LOCAL_QUERIES.payments, [org], (rows) => (payments = rows.map(toPayment)), onError),
			sync.watch<Row>(
				LOCAL_QUERIES.organization,
				[org],
				(rows) => (accepted = jsonArray(rows[0]?.accepted_payment_methods) as PaymentMethod[]),
				onError
			)
		];
		return () => stops.forEach((stop) => stop());
	});

	// Échéances, comptes de caution et bail du locataire choisi.
	$effect(() => {
		const org = organizations.activeId;
		if (!leaseId) return;
		const stops = [
			sync.watch<Row>(LOCAL_QUERIES.leaseDues, [org, leaseId], (rows) => (dueRows = rows)),
			sync.watch<Row>(LOCAL_QUERIES.lease, [org, leaseId], (rows) => (leaseRow = rows[0] ?? null))
		];
		if (canDeposit) {
			stops.push(sync.watch<Row>(LOCAL_QUERIES.leaseDeposits, [org, leaseId], (rows) => (accountRows = rows)));
			stops.push(sync.watch<Row>(LOCAL_QUERIES.leaseMovements, [org, leaseId], (rows) => (movementRows = rows)));
		}
		return () => stops.forEach((stop) => stop());
	});

	const shown = $derived(searchTargets(targets, query));
	const target = $derived(targets.find((x) => x.leaseId === leaseId) ?? null);
	const methods = $derived(role ? selectablePaymentMethods(accepted, role) : []);
	const dues = $derived<DueForScreen[]>(
		dueRows.map((r) => {
			const d = toRentDue(r, today);
			return { ...d, waived: d.status === 'waived' };
		})
	);
	const pending = $derived(leaseId ? pendingRentAmount(payments, leaseId) : 0);
	const suggested = $derived(suggestedRentAmount(dues, pending, today));
	const rent = $derived(Number(leaseRow?.rent ?? 0));
	const securityAccount = $derived.by(() => {
		const row = accountRows.find((a) => a.type === 'security_deposit');
		if (!row) return null;
		const view = toDepositAccount(row, movementRows.map(toMovement), rent);
		const pendingDeposit = payments
			.filter((p) => p.depositAccountId === view.id && ['pending_upload', 'to_validate', 'to_reconcile'].includes(p.status))
			.reduce((s, p) => s + p.amount, 0);
		return { ...view, remaining: Math.max(0, view.balances.remainingDue - pendingDeposit) };
	});
	const outstanding = $derived(outstandingBalance(dues, today));

	// Montants proposés, tant que la personne ne les a pas changés.
	$effect(() => {
		if (touched || !leaseId) return;
		amount = suggested ? String(suggested) : '';
		depositAmount = securityAccount?.remaining ? String(securityAccount.remaining) : '';
	});
	$effect(() => {
		if (!method && methods.length) method = methods[0]!;
	});

	const rentValue = $derived(purpose === 'deposit' ? 0 : (parseFcfa(amount) ?? 0));
	const depositValue = $derived(purpose === 'rent' ? 0 : (parseFcfa(depositAmount) ?? 0));
	const total = $derived(rentValue + depositValue);

	async function choose(id: string) {
		leaseId = id;
		touched = false;
		message = null;
		await tick();
		document.getElementById('montant')?.focus();
	}

	function onSearchKey(event: KeyboardEvent) {
		if (event.key === 'Enter' && shown[0]) {
			event.preventDefault();
			void choose(shown[0].leaseId);
		}
	}

	function entry(extra: Partial<PaymentEntryInput>): PaymentEntryInput {
		const receiptId = newId();
		return {
			id: newId(),
			leaseId: leaseId!,
			purpose: 'rent',
			amount: 0,
			method: method!,
			operator: method === 'mobile_money_manual' ? operator : null,
			transactionReference: method === 'cash' ? null : reference.trim() || null,
			paidOn,
			receiptId,
			provisionalNumber: provisionalReceiptNumber(receiptId),
			verificationToken: newReceiptToken(),
			shareToken: newReceiptToken(),
			...extra
		};
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		message = null;
		const org = organizations.activeId;
		if (!org || !leaseId || !method) return;
		const entries: PaymentEntryInput[] = [];
		if (purpose !== 'rent') {
			if (!securityAccount) return void (message = t.noDepositAccount);
			if (depositValue > securityAccount.remaining) return void (message = fr.leases.receivedTooMuch);
			entries.push(entry({ purpose: 'deposit', depositAccountId: securityAccount.id, amount: depositValue }));
		}
		if (purpose !== 'deposit' && (purpose === 'rent' || rentValue > 0)) entries.push(entry({ amount: rentValue }));
		const parsed = paymentEntriesSchema.safeParse({ payments: entries });
		if (!parsed.success) return void (message = parsed.error.issues[0]!.message);
		// Point b : prévenu dès l'appareil ; le serveur tranche de toute façon à la synchronisation.
		for (const e of parsed.data.payments) {
			const dup = duplicateMobileMoneyPayment(
				payments.map((p) => ({ ...p, status: p.status === 'pending_upload' ? 'to_reconcile' : p.status })),
				e
			);
			if (dup) return void (message = t.duplicateWarning);
		}
		busy = true;
		try {
			await recordPayments(sync.db ?? (await sync.start()), org, parsed.data.payments);
			await goto(resolve('/app/encaissements/[id]', { id: parsed.data.payments.at(-1)!.id }));
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}

	const option =
		'flex min-h-14 items-center gap-3 rounded-xl border-2 bg-card px-4 text-left text-base font-medium has-checked:border-primary has-checked:bg-primary/5';
	const methodIcon = { cash: Banknote, mobile_money_manual: Smartphone, bank_transfer: Building } as const;
	const twoPane = $derived(device.isDesktop || device.twoPane);
</script>

<PageHeader title={t.collectTitle} subtitle={t.collectSubtitle} />

<main class="page pt-3 pb-10" data-testid="encaisser">
	{#if !canCollect}
		<FormAlert message={fr.app.notFound} />
	{:else}
		<FeatureGate key="payments.registry">
			{#if signedLease}
				<div class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4" data-testid="apres-signature">
					<p class="min-w-0 flex-1 text-base">{t.afterSignature}</p>
					<Button variant="outline" href={resolve('/app/baux/[id]', { id: signedLease })} data-testid="plus-tard"
						><ArrowLeft class="size-5" aria-hidden="true" />{t.later}</Button
					>
				</div>
			{/if}
			<FormAlert {message} />
			<div class={cn('gap-6', twoPane ? 'grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-start' : 'space-y-4')}>
				{#if twoPane || !target}
					<section class="space-y-3" aria-labelledby="titre-locataire">
						<h2 id="titre-locataire" class="text-base font-semibold text-muted-foreground">{t.step1}</h2>
						<div class="relative">
							<Search
								class="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground"
								aria-hidden="true"
							/>
							<Input
								type="search"
								bind:value={query}
								placeholder={t.search}
								aria-label={t.searchLabel}
								class="pl-10"
								onkeydown={onSearchKey}
								data-testid="recherche-locataire"
							/>
						</div>
						{#if !targets.length}
							<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground">
								{role === 'field_agent' ? t.noTargetsAgent : t.noTargets}
							</p>
						{:else if !shown.length}
							<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground">{t.noTarget}</p>
						{:else}
							<ul class="space-y-2" aria-label={t.searchLabel}>
								{#each shown.slice(0, 50) as x (x.leaseId)}
									<li>
										<button
											type="button"
											class={cn(
												'block w-full space-y-0.5 rounded-xl border-2 bg-card p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
												x.leaseId === leaseId ? 'border-primary' : 'border-transparent hover:border-input'
											)}
											aria-pressed={x.leaseId === leaseId}
											onclick={() => choose(x.leaseId)}
											data-testid="cible"
										>
											<span class="block font-semibold break-words">{x.tenantName}</span>
											<span class="block text-sm break-words text-muted-foreground"
												>{x.propertyName} — {x.unitLabel}{x.tenantPhone ? ` · ${formatPhone(x.tenantPhone)}` : ''}</span
											>
										</button>
									</li>
								{/each}
							</ul>
						{/if}
					</section>
				{/if}

				{#if target}
					<form class="space-y-5" onsubmit={submit} data-testid="formulaire-encaissement">
						<div class="flex flex-wrap items-start justify-between gap-2 rounded-xl border bg-card p-4">
							<div class="min-w-0">
								<p class="font-semibold break-words" data-testid="locataire-choisi">{target.tenantName}</p>
								<p class="text-sm break-words text-muted-foreground">{target.propertyName} — {target.unitLabel}</p>
								<p class="mt-1 text-base tabular-nums">
									{t.due} : <strong>{formatFcfa(outstanding)}</strong>
									{#if pending}<span class="text-sm text-muted-foreground"> ({t.pendingNote(formatFcfa(pending))})</span>{/if}
								</p>
							</div>
							{#if !twoPane}<Button type="button" variant="outline" onclick={() => (leaseId = null)}>{t.change}</Button>{/if}
						</div>

						{#if canDeposit && securityAccount}
							<fieldset class="space-y-2">
								<legend class="text-base font-semibold text-muted-foreground">{t.object}</legend>
								<div class="grid gap-2 sm:grid-cols-3">
									{#each [['rent', t.rent], ['deposit', t.deposit], ['both', t.depositAndAdvance]] as const as [value, label] (value)}
										<label class={option}>
											<input type="radio" name="objet" {value} bind:group={purpose} class="size-5" />{label}
										</label>
									{/each}
								</div>
								{#if purpose === 'both'}<p class="text-sm text-muted-foreground">{t.depositAndAdvanceHint}</p>{/if}
							</fieldset>
						{/if}

						<fieldset class="space-y-3">
							<legend class="text-base font-semibold text-muted-foreground">{t.step2}</legend>
							{#if purpose !== 'rent'}
								<div class="space-y-1">
									<label for="montant-caution" class="text-base font-medium">{t.depositAmount}</label>
									<Input
										id="montant-caution"
										inputmode="numeric"
										bind:value={depositAmount}
										oninput={() => (touched = true)}
										class="text-xl font-semibold tabular-nums"
										data-testid="montant-caution"
									/>
									{#if securityAccount}<p class="text-sm text-muted-foreground">
											{t.depositRemaining(formatFcfa(securityAccount.remaining))}
										</p>{/if}
								</div>
							{/if}
							{#if purpose !== 'deposit'}
								<div class="space-y-1">
									<label for="montant" class="text-base font-medium">{purpose === 'both' ? t.advanceAmount : t.amount}</label>
									<Input
										id="montant"
										inputmode="numeric"
										bind:value={amount}
										oninput={() => (touched = true)}
										class="text-xl font-semibold tabular-nums"
										data-testid="montant"
									/>
									<p class="text-sm text-muted-foreground">{t.amountHint}</p>
								</div>
							{/if}
						</fieldset>

						<fieldset class="space-y-2">
							<legend class="text-base font-semibold text-muted-foreground">{t.step3}</legend>
							{#if !methods.length}
								<FormAlert message={t.methodNotAccepted} />
							{:else}
								<div class="grid gap-2 sm:grid-cols-3">
									{#each methods as m (m)}
										{@const Icon = methodIcon[m]}
										<label class={option} data-testid={`moyen-${m}`}>
											<input type="radio" name="moyen" value={m} bind:group={method} class="size-5" />
											<Icon class="size-5 shrink-0" aria-hidden="true" />
											<span class="min-w-0"
												><span class="block">{t.methods[m]}</span><span class="block text-sm font-normal text-muted-foreground"
													>{t.methodHints[m]}</span
												></span
											>
										</label>
									{/each}
								</div>
								{#if role === 'field_agent'}<p class="text-sm text-muted-foreground">{t.fieldAgentCashOnly}</p>{/if}
							{/if}
							{#if method === 'mobile_money_manual'}
								<div class="space-y-3 pt-2">
									<fieldset class="space-y-2">
										<legend class="text-base font-medium">{t.operator}</legend>
										<div class="flex flex-wrap gap-2">
											{#each MOBILE_MONEY_OPERATORS as op (op)}
												<label class="flex min-h-11 items-center gap-2 rounded-lg border-2 bg-card px-3 has-checked:border-primary">
													<input type="radio" name="operateur" value={op} bind:group={operator} />{t.operators[op]}
												</label>
											{/each}
										</div>
									</fieldset>
									<div class="space-y-1">
										<label for="reference" class="text-base font-medium">{t.reference}</label>
										<Input id="reference" bind:value={reference} autocapitalize="characters" data-testid="reference" />
										<p class="text-sm text-muted-foreground">{t.referenceHint}</p>
									</div>
								</div>
							{:else if method === 'bank_transfer'}
								<div class="space-y-1 pt-2">
									<label for="reference" class="text-base font-medium">{t.transferReference}</label>
									<Input id="reference" bind:value={reference} data-testid="reference" />
								</div>
							{/if}
						</fieldset>

						<details class="rounded-xl border bg-card p-3">
							<summary class="min-h-11 cursor-pointer content-center text-base font-medium"
								>{t.paidOn} : {paidOn.split('-').reverse().join('/')}</summary
							>
							<label for="date-paiement" class="sr-only">{t.paidOn}</label>
							<Input id="date-paiement" type="date" bind:value={paidOn} max={today} class="mt-2" />
						</details>

						<div class={cn(!device.isDesktop && 'sticky bottom-24 z-10')}>
							<Button
								type="submit"
								size="lg"
								class="w-full text-lg"
								disabled={busy || !methods.length || total <= 0}
								data-testid="valider-encaissement"
							>
								<Check class="size-6" aria-hidden="true" />{busy ? t.submitting : t.submit(formatFcfa(total))}
							</Button>
						</div>
					</form>
				{/if}
			</div>
		</FeatureGate>
	{/if}
</main>
