<script lang="ts">
	/**
	 * Fiche bail (lot 08, docs/UX.md §10) : conditions et paramètres, échéancier, compte de caution, documents,
	 * chronologie et versions. Lue sur l'appareil, sans appel réseau ; les actions écrivent sur l'appareil et partent par
	 * la synchronisation, où le serveur décide (statut, échéances, version). Un bail validé hors ligne montre l'aperçu de
	 * son échéancier, calculé par la même fonction pure que le serveur. Un bail peut être en vigueur sans contrat signé :
	 * il porte l'alerte « Contrat non signé » (D20).
	 */
	import { onMount } from 'svelte';
	import { Ban, CheckCircle2, CircleAlert, HandCoins, LogOut, Pencil, Repeat2 } from '@lucide/svelte';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import type { DocumentView } from '@ziga/shared/documents';
	import { formatDate, toIsoDate } from '@ziga/shared/dates';
	import { newId } from '@ziga/shared/ids';
	import {
		cancelLeaseSchema,
		depositHolderChangeSchema,
		outstandingBalance,
		rentChangeSchema,
		type DepositAccountView,
		type DepositMovementView,
		type LeaseVersionView,
		type LeaseView,
		type RentDueView,
		type TenantView
	} from '@ziga/shared/leases';
	import { formatFcfa, parseFcfa } from '@ziga/shared/money';
	import { can } from '@ziga/shared/permissions';
	import type { UnitView } from '@ziga/shared/properties';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import MaintenanceRequestsSection from '#lib/components/portals/MaintenanceRequestsSection.svelte';
	import LeaseContractSection from '#lib/components/contracts/LeaseContractSection.svelte';
	import NoticeForm from '#lib/components/exit/NoticeForm.svelte';
	import DocumentsSection from '#lib/components/properties/DocumentsSection.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import {
		leaseTimeline,
		previewSchedule,
		toDepositAccount,
		toLease,
		toLeaseVersion,
		toMovement,
		toRentDue,
		toTenant
	} from '#lib/leases/views.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { toDocument, toUnit } from '#lib/properties/views.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';
	import { cancelLease, changeDepositHolder, changeRent, requestLeaseValidation } from '#lib/sync/writes.ts';

	type Row = Record<string, unknown>;
	const t = fr.leases;
	const today = toIsoDate();
	const role = $derived(organizations.active?.role);
	const canUpdate = $derived(can(role, 'lease.update'));
	const canReceive = $derived(can(role, 'deposit.receive'));
	const canDocuments = $derived(can(role, 'document.read'));
	const id = $derived(page.params.id ?? '');

	let leaseRow = $state<Row | null>(null);
	let unit = $state<UnitView | null>(null);
	let tenant = $state<TenantView | null>(null);
	let dueRows = $state<Row[]>([]);
	let accountRows = $state<Row[]>([]);
	let movements = $state<DepositMovementView[]>([]);
	let versions = $state<LeaseVersionView[]>([]);
	let documents = $state<DocumentView[]>([]);
	let loaded = $state(false);
	let message = $state<string | null>(null);
	let saved = $state<string | null>(null);
	let panel = $state<'cancel' | 'rent' | `holder:${string}` | null>(null);
	let form = $state<Record<string, string>>({});
	let noticeOpen = $state(false);

	onMount(() => {
		const org = organizations.activeId;
		const onError = (error: Error) => (message = messageOf(error));
		const stops = [
			sync.watch<Row>(
				LOCAL_QUERIES.lease,
				[org, id],
				(rows) => {
					leaseRow = rows[0] ?? null;
					loaded = true;
				},
				onError
			),
			sync.watch<Row>(LOCAL_QUERIES.leaseDues, [org, id], (rows) => (dueRows = rows), onError),
			sync.watch<Row>(LOCAL_QUERIES.leaseVersions, [org, id], (rows) => (versions = rows.map(toLeaseVersion)), onError),
			sync.watch<Row>(LOCAL_QUERIES.leaseDeposits, [org, id], (rows) => (accountRows = rows), onError),
			sync.watch<Row>(LOCAL_QUERIES.leaseMovements, [org, id], (rows) => (movements = rows.map(toMovement)), onError)
		];
		return () => stops.forEach((stop) => stop());
	});

	// Unité, locataire et documents, dès que le bail est lu.
	$effect(() => {
		const org = organizations.activeId;
		const unitId = leaseRow ? String(leaseRow.unit_id) : null;
		const tenantId = leaseRow ? String(leaseRow.tenant_id) : null;
		if (!unitId || !tenantId) return;
		const stops = [
			sync.watch<Row>(LOCAL_QUERIES.unit, [org, unitId], (rows) => (unit = rows[0] ? toUnit(rows[0]) : null)),
			sync.watch<Row>(LOCAL_QUERIES.tenant, [org, tenantId], (rows) => (tenant = rows[0] ? toTenant(rows[0]) : null))
		];
		if (canDocuments) {
			stops.push(sync.watch<Row>(LOCAL_QUERIES.leaseDocuments, [org, id, tenantId], (rows) => (documents = rows.map(toDocument))));
		}
		return () => stops.forEach((stop) => stop());
	});

	const hasScan = $derived(documents.some((d) => d.type === 'signed_lease_scan' && d.status === 'active'));
	const lease = $derived<LeaseView | null>(leaseRow ? toLease(leaseRow, hasScan) : null);
	const dues = $derived<RentDueView[]>(dueRows.map((r) => toRentDue(r, today)));
	const accounts = $derived<DepositAccountView[]>(lease ? accountRows.map((r) => toDepositAccount(r, movements, lease.rent)) : []);
	/** Validé sur l'appareil, pas encore confirmé par le serveur (pas de date de signature reçue). */
	const pending = $derived(!!lease && lease.status !== 'draft' && !lease.activatedOn);
	const preview = $derived(lease && !dues.length && lease.status !== 'cancelled' ? previewSchedule(lease, today) : []);
	const outstanding = $derived(
		outstandingBalance(
			dues.map((d) => ({ ...d, waived: d.status === 'waived' })),
			today
		)
	);
	const timeline = $derived(lease ? leaseTimeline(lease, versions, movements, documents) : []);
	/** Échéances du serveur, ou l'aperçu calculé sur l'appareil (statut inconnu tant que le serveur n'a pas validé). */
	const list = $derived(
		dues.length
			? dues.map((d) => ({
					key: d.id,
					start: d.periodStart,
					end: d.periodEnd,
					dueOn: d.dueOn,
					amount: d.amountDue,
					balance: d.balance,
					status: d.status as string | null,
					isAdvance: d.isAdvance,
					prorated: d.prorated,
					opening: d.kind === 'opening_balance'
				}))
			: preview.map((d) => ({
					key: d.periodStart,
					start: d.periodStart,
					end: d.periodEnd,
					dueOn: d.dueOn,
					amount: d.amountDue,
					balance: d.amountDue,
					status: null as string | null,
					isAdvance: d.isAdvance,
					prorated: d.prorated,
					opening: false
				}))
	);
	const validated = $derived(!!lease && ['signed', 'active', 'notice'].includes(lease.status) && !pending);

	const tone = (s: string) => (s === 'active' ? 'success' : s === 'cancelled' || s === 'ended' ? 'secondary' : 'info');
	const dueTone = (s: string) =>
		s === 'paid' ? 'success' : s === 'overdue' ? 'danger' : s === 'due' || s === 'partial' ? 'warning' : 'secondary';

	async function db() {
		return sync.db ?? (await sync.start());
	}

	async function run(fn: () => Promise<void>, done: string = t.saved) {
		message = null;
		saved = null;
		try {
			await fn();
			panel = null;
			form = {};
			saved = done;
		} catch (error) {
			message = messageOf(error);
		}
	}

	function open(p: typeof panel) {
		panel = panel === p ? null : p;
		form = { date: today };
		message = null;
	}

	async function validate() {
		const org = organizations.activeId;
		if (!org || !lease) return;
		await run(async () => requestLeaseValidation(await db(), org, lease.id, lease.startsOn, today), fr.leases.wizard.validated);
	}

	async function cancel(event: SubmitEvent) {
		event.preventDefault();
		const org = organizations.activeId;
		if (!org || !lease) return;
		const parsed = cancelLeaseSchema.safeParse({ reason: form.reason ?? '' });
		if (!parsed.success) return void (message = parsed.error.issues[0]!.message);
		await run(async () => cancelLease(await db(), org, lease.id, parsed.data.reason));
	}

	async function newRent(event: SubmitEvent) {
		event.preventDefault();
		const org = organizations.activeId;
		if (!org || !lease) return;
		const parsed = rentChangeSchema.safeParse({
			rent: parseFcfa(form.rent ?? ''),
			charges: parseFcfa(form.charges ?? String(lease.charges)) ?? 0,
			effectiveFrom: form.from ?? '',
			expectedVersion: lease.version
		});
		if (!parsed.success) return void (message = parsed.error.issues[0]!.message);
		await run(async () =>
			changeRent(await db(), org, lease.id, {
				rent: parsed.data.rent,
				charges: parsed.data.charges,
				effectiveFrom: parsed.data.effectiveFrom,
				currentVersion: lease.version
			})
		);
	}

	async function holder(event: SubmitEvent, account: DepositAccountView) {
		event.preventDefault();
		const org = organizations.activeId;
		if (!org) return;
		const parsed = depositHolderChangeSchema.safeParse({
			id: newId(),
			accountId: account.id,
			newHolder: account.holder === 'owner' ? 'organization' : 'owner',
			occurredOn: form.date ?? today,
			reason: form.reason ?? ''
		});
		if (!parsed.success) return void (message = parsed.error.issues[0]!.message);
		// Un compte passé au nouveau gestionnaire (lot 10 bis) est soldé : il ne change plus de détenteur.
		if (account.holder === 'third_party') return;
		const previousHolder = account.holder;
		await run(async () => changeDepositHolder(await db(), org, { ...parsed.data, previousHolder }));
	}

	function eventLabel(e: (typeof timeline)[number]): string {
		const d = e.detail;
		if (e.kind === 'rent_change')
			return `${t.events.rent_change} : ${formatFcfa(Number(d.rent))} (${t.version(Number(d.version))}, ${formatDate(String(d.from))})`;
		if (e.kind === 'deposit') return `${t.movementTypes[String(d.type)]} : ${formatFcfa(Number(d.amount))}`;
		if (e.kind === 'holder') return `${t.events.holder} : ${t.holders[String(d.holder)]}`;
		if (e.kind === 'document') return `${t.events.document} : ${d.fileName}`;
		if (e.kind === 'validated') return `${t.events.validated} (${t.status[String(d.status)]})`;
		if (e.kind === 'cancelled') return `${t.events.cancelled}${d.reason ? ` : ${d.reason}` : ''}`;
		return t.events[e.kind] ?? e.kind;
	}
</script>

<PageHeader title={unit ? t.leaseOf(unit.label) : t.title} subtitle={tenant?.fullName} back="app/locataires" backLabel={fr.tenants.back} />

<main class="page space-y-4 pt-3 pb-10" data-testid="fiche-bail" data-statut={lease?.status}>
	<FormAlert {message} />
	{#if saved}<FormAlert message={saved} tone="info" />{/if}
	{#if loaded && !lease}
		<FormAlert message={t.notFound} />
	{:else if lease}
		<section class="space-y-3 rounded-2xl border bg-card p-4 md:p-6">
			<div class="flex flex-wrap items-center gap-2">
				<Badge variant={tone(lease.status)} data-testid="statut-bail">{t.status[lease.status]}</Badge>
				{#if pending}<Badge variant="secondary" data-testid="attente-synchro">{t.pendingSync}</Badge>{/if}
				{#if lease.alerts.includes('contract_unsigned')}
					<Badge variant="warning" data-testid="alerte-contrat"><CircleAlert class="size-4" aria-hidden="true" />{t.contractUnsigned}</Badge
					>
				{/if}
			</div>
			{#if lease.alerts.includes('contract_unsigned')}<p class="text-sm text-muted-foreground">{t.contractUnsignedHint}</p>{/if}
			<dl class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				<div>
					<dt class="text-sm text-muted-foreground">{t.tenant}</dt>
					<dd class="text-base">
						{#if tenant}<a class="underline" href={resolve('/app/locataires/[id]', { id: tenant.id })}>{tenant.fullName}</a>{/if}
					</dd>
				</div>
				<div>
					<dt class="text-sm text-muted-foreground">{t.unit}</dt>
					<dd class="text-base">
						{#if unit}<a class="underline" href={resolve('/app/biens/[id]', { id: unit.propertyId })}>{unit.label}</a>{/if}
					</dd>
				</div>
				<div>
					<dt class="text-sm text-muted-foreground">{t.start}</dt>
					<dd class="text-base">{formatDate(lease.startsOn)}</dd>
				</div>
				<div>
					<dt class="text-sm text-muted-foreground">{t.end}</dt>
					<dd class="text-base">{lease.endsOn ? formatDate(lease.endsOn) : t.openEnded}</dd>
				</div>
				{#if lease.originalEndsOn}
					<div>
						<dt class="text-sm text-muted-foreground">{t.originalEnd}</dt>
						<dd class="text-base" data-testid="fin-origine">{formatDate(lease.originalEndsOn)}</dd>
						<dd class="text-sm text-muted-foreground">{t.originalEndHint}</dd>
					</div>
				{/if}
				<div>
					<dt class="text-sm text-muted-foreground">{t.rent}</dt>
					<dd class="text-base tabular-nums" data-testid="loyer">{formatFcfa(lease.rent)}</dd>
				</div>
				<div>
					<dt class="text-sm text-muted-foreground">{t.charges}</dt>
					<dd class="text-base tabular-nums">{formatFcfa(lease.charges)}</dd>
				</div>
				<div>
					<dt class="text-sm text-muted-foreground">{t.dueDay}</dt>
					<dd class="text-base">{lease.billingMode === 'anniversary' ? '—' : lease.dueDay}</dd>
				</div>
				<div>
					<dt class="text-sm text-muted-foreground">{t.billingMode}</dt>
					<dd class="text-base">{t.billingModes[lease.billingMode]}</dd>
				</div>
				<div>
					<dt class="text-sm text-muted-foreground">{t.lessor}</dt>
					<dd class="text-base">{t.lessors[lease.lessorType]}</dd>
				</div>
			</dl>
			<details class="rounded-xl border p-3">
				<summary class="min-h-11 cursor-pointer content-center font-medium">{t.parameters}</summary>
				<p class="mt-2 text-sm text-muted-foreground">{t.parametersHint}</p>
				<dl class="mt-2 grid gap-3 sm:grid-cols-2">
					<div>
						<dt class="text-sm text-muted-foreground">{t.noticeTenantFixed}</dt>
						<dd class="text-base">{lease.noticeTenantFixedTermMonths}</dd>
					</div>
					<div>
						<dt class="text-sm text-muted-foreground">{t.noticeTenantOpen}</dt>
						<dd class="text-base">{lease.noticeTenantOpenEndedMonths}</dd>
					</div>
					<div>
						<dt class="text-sm text-muted-foreground">{t.noticeLessorFixed}</dt>
						<dd class="text-base">{lease.noticeLessorFixedTermMonths}</dd>
					</div>
					<div>
						<dt class="text-sm text-muted-foreground">{t.noticeLessorOpen}</dt>
						<dd class="text-base">{lease.noticeLessorOpenEndedMonths}</dd>
					</div>
					<div>
						<dt class="text-sm text-muted-foreground">{t.renewal}</dt>
						<dd class="text-base">{t.renewals[lease.renewalMode]}</dd>
					</div>
					<div>
						<dt class="text-sm text-muted-foreground">{t.refundDays}</dt>
						<dd class="text-base">{lease.depositRefundDays}</dd>
					</div>
					<div>
						<dt class="text-sm text-muted-foreground">{t.penalty}</dt>
						<dd class="text-base">
							{lease.penaltyRateBp
								? `${(lease.penaltyRateBp / 100).toLocaleString('fr-FR')} % · ${lease.penaltyGraceDays} j · ${t.beneficiaries[lease.penaltyBeneficiary ?? 'organization']}`
								: t.penaltyNone}
						</dd>
					</div>
					{#if lease.paymentTerms}<div>
							<dt class="text-sm text-muted-foreground">{t.paymentTerms}</dt>
							<dd class="text-base break-words">{lease.paymentTerms}</dd>
						</div>{/if}
				</dl>
			</details>
			<!-- Lot 10 bis : congé (préavis) et sortie du locataire. -->
			{#if (lease.status === 'active' && can(role, 'lease.notice')) || lease.status === 'notice' || lease.status === 'ended'}
				<div class="flex flex-wrap gap-2">
					{#if lease.status === 'active' && can(role, 'lease.notice')}
						<Button onclick={() => (noticeOpen = true)} disabled={!sync.online} data-testid="preavis"
							><LogOut aria-hidden="true" />{fr.exit.notice.action}</Button
						>
					{/if}
					{#if lease.status === 'notice' || lease.status === 'ended'}
						<Button variant="outline" href={resolve('/app/sorties/[id]', { id: lease.id })} data-testid="ouvrir-sortie"
							><LogOut aria-hidden="true" />{fr.exit.open}</Button
						>
					{/if}
				</div>
				{#if lease.status === 'active' && can(role, 'lease.notice') && !sync.online}<p class="text-sm text-muted-foreground">
						{fr.exit.onlineOnly}
					</p>{/if}
				<NoticeForm bind:open={noticeOpen} {lease} />
			{/if}
			{#if canUpdate}
				<div class="flex flex-wrap gap-2">
					{#if lease.status === 'draft'}
						<Button onclick={validate} data-testid="valider-bail"><CheckCircle2 aria-hidden="true" />{t.validate}</Button>
						<Button variant="outline" href={resolve(`/app/baux/assistant?bail=${lease.id}&etape=2`)}
							><Pencil aria-hidden="true" />{fr.tenants.edit}</Button
						>
					{/if}
					{#if validated && lease.status !== 'notice'}
						<Button variant="outline" onclick={() => open('rent')} data-testid="modifier-loyer"
							><Repeat2 aria-hidden="true" />{t.changeRent}</Button
						>
					{/if}
					{#if lease.status === 'draft' || lease.status === 'signed'}
						<Button variant="outline" onclick={() => open('cancel')}><Ban aria-hidden="true" />{t.cancel}</Button>
					{/if}
				</div>
				{#if lease.status === 'draft'}<p class="text-sm text-muted-foreground">{t.validateHint}</p>{/if}
				{#if panel === 'cancel'}
					<form class="space-y-3 rounded-xl border p-4" onsubmit={cancel} novalidate>
						<label for="motif-annulation" class="block font-medium">{t.cancelReason}</label>
						<Input id="motif-annulation" bind:value={form.reason} />
						<Button type="submit" variant="destructive">{t.cancelSubmit}</Button>
					</form>
				{:else if panel === 'rent'}
					<form class="space-y-3 rounded-xl border p-4" onsubmit={newRent} novalidate data-testid="formulaire-loyer">
						<p class="text-sm text-muted-foreground">{t.changeRentHint}</p>
						<div class="grid gap-3 sm:grid-cols-3">
							<div class="space-y-1">
								<label for="nouveau-loyer" class="block font-medium">{t.rent}</label><Input
									id="nouveau-loyer"
									inputmode="numeric"
									bind:value={form.rent}
								/>
							</div>
							<div class="space-y-1">
								<label for="nouvelles-charges" class="block font-medium">{t.charges}</label><Input
									id="nouvelles-charges"
									inputmode="numeric"
									bind:value={form.charges}
									placeholder={String(lease.charges)}
								/>
							</div>
							<div class="space-y-1">
								<label for="date-effet" class="block font-medium">{t.effectiveFrom}</label><Input
									id="date-effet"
									type="date"
									bind:value={form.from}
								/>
							</div>
						</div>
						<Button type="submit">{t.changeRentSubmit}</Button>
					</form>
				{/if}
			{/if}
		</section>

		{#if can(role, 'contract.read')}<LeaseContractSection {lease} disabled={pending || sync.pending > 0} />{/if}

		<section class="space-y-3 rounded-2xl border bg-card p-4 md:p-6" data-testid="echeancier">
			<div class="flex flex-wrap items-center justify-between gap-2">
				<h2 class="text-lg font-semibold">{t.schedule}</h2>
				{#if dues.length}<span class="text-base tabular-nums">{t.outstanding} : <strong>{formatFcfa(outstanding)}</strong></span>{/if}
				<!-- Lot 09 : encaisser un loyer de ce bail (écran « Encaisser », locataire déjà choisi). -->
				{#if can(role, 'payment.record_cash') && lease && ['signed', 'active', 'notice'].includes(lease.status)}
					<Button href={resolve(`/app/encaisser?bail=${id}`)} data-testid="encaisser-loyer"
						><HandCoins aria-hidden="true" />{fr.payments.collect}</Button
					>
				{/if}
			</div>
			{#if !dues.length && preview.length}
				<FormAlert message={t.preview} tone="info" />
			{/if}
			{#if !list.length}
				<p class="text-base text-muted-foreground">{t.noDues}</p>
			{:else if device.isDesktop}
				<div class="relative overflow-x-auto rounded-xl border">
					<table class="w-full text-left text-base">
						<thead class="border-b text-muted-foreground">
							<tr>
								<th class="px-4 py-2 font-medium">{t.period}</th>
								<th class="px-4 py-2 font-medium">{t.dueOn}</th>
								<th class="px-4 py-2 text-right font-medium">{t.amount}</th>
								<th class="px-4 py-2 text-right font-medium">{t.balance}</th>
								<th class="px-4 py-2 font-medium"><span class="sr-only">{t.dueStatus.due}</span></th>
							</tr>
						</thead>
						<tbody class="divide-y">
							{#each list as d (d.key)}
								<tr
									data-testid="echeance"
									data-preview={d.status === null ? '1' : undefined}
									data-kind={d.opening ? 'opening_balance' : 'rent'}
								>
									<td class="px-4 py-2">
										{#if d.opening}<span class="block font-medium" title={t.openingBalanceHint}>{t.openingBalance}</span>{/if}
										<span class={d.opening ? 'text-sm whitespace-nowrap text-muted-foreground' : 'whitespace-nowrap'}
											>{formatDate(d.start)} → {formatDate(d.end)}</span
										>
									</td>
									<td class="px-4 py-2 whitespace-nowrap">{formatDate(d.dueOn)}</td>
									<td class="px-4 py-2 text-right whitespace-nowrap tabular-nums">{formatFcfa(d.amount)}</td>
									<td class="px-4 py-2 text-right whitespace-nowrap tabular-nums">{formatFcfa(d.balance)}</td>
									<td class="px-4 py-2">
										<span class="flex flex-wrap gap-1">
											{#if d.status}<Badge variant={dueTone(d.status)}>{t.dueStatus[d.status]}</Badge>{/if}
											{#if d.isAdvance}<Badge variant="info">{t.advanceDue}</Badge>{/if}
											{#if d.prorated}<Badge variant="secondary">{t.prorated}</Badge>{/if}
										</span>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else}
				<ul class="divide-y rounded-xl border">
					{#each list as d (d.key)}
						<li
							class="space-y-1 p-3"
							data-testid="echeance"
							data-preview={d.status === null ? '1' : undefined}
							data-kind={d.opening ? 'opening_balance' : 'rent'}
						>
							{#if d.opening}<span class="block text-sm text-muted-foreground">{t.openingBalanceHint}</span>{/if}
							<span class="flex flex-wrap items-center justify-between gap-2">
								<span class="font-medium"
									>{#if d.opening}{t.openingBalance} :
									{/if}{formatDate(d.start)} → {formatDate(d.end)}</span
								>
								<span class="tabular-nums">{formatFcfa(d.amount)}</span>
							</span>
							<span class="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
								{t.dueOn}
								{formatDate(d.dueOn)}
								{#if d.status}<Badge variant={dueTone(d.status)}>{t.dueStatus[d.status]}</Badge>{/if}
								{#if d.isAdvance}<Badge variant="info">{t.advanceDue}</Badge>{/if}
								{#if d.prorated}<Badge variant="secondary">{t.prorated}</Badge>{/if}
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		{#if can(role, 'deposit.read')}
			<section class="space-y-3 rounded-2xl border bg-card p-4 md:p-6" data-testid="caution">
				<h2 class="text-lg font-semibold">{t.deposits}</h2>
				{#if !accounts.length}<p class="text-base text-muted-foreground">{t.noDeposit}</p>{/if}
				{#each accounts as a (a.id)}
					<article class="space-y-3 rounded-xl border p-4" data-testid="compte-caution">
						<div class="flex flex-wrap items-center justify-between gap-2">
							<h3 class="font-semibold">{t.depositTypes[a.type]}</h3>
							<Badge variant={a.status === 'held' ? 'success' : 'secondary'}>{t.depositStatus[a.status]}</Badge>
						</div>
						{#if a.aboveLegalCap}<FormAlert message={t.aboveCap} tone="info" />{/if}
						<dl class="grid grid-cols-2 gap-3 sm:grid-cols-4">
							<div>
								<dt class="text-sm text-muted-foreground">{t.agreed}</dt>
								<dd class="tabular-nums">{formatFcfa(a.agreedAmount)}</dd>
							</div>
							<div>
								<dt class="text-sm text-muted-foreground">{t.received}</dt>
								<dd class="tabular-nums" data-testid="caution-recue">{formatFcfa(a.balances.received)}</dd>
							</div>
							<div>
								<dt class="text-sm text-muted-foreground">{t.remaining}</dt>
								<dd class="tabular-nums" data-testid="caution-reste">{formatFcfa(a.balances.remainingDue)}</dd>
							</div>
							<div>
								<dt class="text-sm text-muted-foreground">{t.holder}</dt>
								<dd data-testid="detenteur">{t.holders[a.holder]}</dd>
							</div>
						</dl>
						{#if a.movements.length}
							<ul class="divide-y rounded-lg border text-base">
								{#each a.movements as m (m.id)}
									<li class="flex flex-wrap justify-between gap-2 p-2">
										<span
											>{formatDate(m.occurredOn)} · {t.movementTypes[m.type]}{m.type === 'holder_changed' && m.newHolder
												? ` : ${t.holders[m.newHolder]}`
												: ''}</span
										>
										{#if m.amount}<span class="tabular-nums">{formatFcfa(m.amount)}</span>{/if}
									</li>
								{/each}
							</ul>
						{/if}
						<div class="flex flex-wrap gap-2">
							{#if canReceive && a.balances.remainingDue > 0 && a.status !== 'closed'}
								<!-- Lot 09 : un versement de caution s'encaisse, avec son reçu (réponse du porteur, point 3). -->
								<Button variant="outline" href={resolve(`/app/encaisser?bail=${id}&objet=caution`)} data-testid="encaisser-caution"
									><HandCoins aria-hidden="true" />{t.receive}</Button
								>
							{/if}
							{#if canUpdate && organizations.active?.type !== 'landlord' && a.status !== 'closed'}
								<Button variant="outline" onclick={() => open(`holder:${a.id}`)}><Repeat2 aria-hidden="true" />{t.changeHolder}</Button>
							{/if}
						</div>
						{#if panel === `holder:${a.id}`}
							<form class="space-y-3 rounded-lg border p-3" onsubmit={(e) => holder(e, a)} novalidate>
								<p class="text-base">{t.holders[a.holder]} → {t.holders[a.holder === 'owner' ? 'organization' : 'owner']}</p>
								<label for={`motif-${a.id}`} class="block font-medium">{t.changeHolderReason}</label>
								<Input id={`motif-${a.id}`} bind:value={form.reason} />
								<Button type="submit">{t.changeHolderSubmit}</Button>
							</form>
						{/if}
					</article>
				{/each}
			</section>
		{/if}

		{#if canDocuments}
			{#if sync.online}
				<DocumentsSection leaseId={lease.id} tenantId={lease.tenantId} {documents} disabled={sync.pending > 0} />
			{:else}
				<FormAlert message={t.documentsOnline} tone="info" />
			{/if}
		{/if}

		<section class="space-y-3 rounded-2xl border bg-card p-4 md:p-6" data-testid="chronologie">
			<h2 class="text-lg font-semibold">{t.timeline}</h2>
			<ol class="space-y-2">
				{#each timeline as e, i (i)}
					<li class="flex flex-wrap gap-2 text-base">
						<span class="text-muted-foreground tabular-nums">{formatDate(e.date)}</span><span class="break-words">{eventLabel(e)}</span>
					</li>
				{/each}
			</ol>
			{#if versions.length}
				<h3 class="pt-2 font-semibold">{t.versions}</h3>
				<ul class="divide-y rounded-lg border">
					{#each versions as v (v.version)}
						<li class="flex flex-wrap justify-between gap-2 p-2 text-base">
							<span>{t.version(v.version)} · {formatDate(v.rentEffectiveFrom)}</span><span class="tabular-nums"
								>{formatFcfa(v.rent)} + {formatFcfa(v.charges)}</span
							>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
		<MaintenanceRequestsSection leaseId={id} />
	{/if}
</main>
