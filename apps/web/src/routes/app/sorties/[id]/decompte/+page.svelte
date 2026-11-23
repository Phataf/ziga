<script lang="ts">
	/**
	 * Décompte de caution (lot 10 bis, étape 4 ; règle 14, D15, D32), lu sur l'appareil. Chaque ligne montre son
	 * justificatif ou ce qui manque (refus nommé du serveur) : une retenue non justifiée n'est jamais comptée, et le
	 * formulaire d'une réparation exige montant et devis, comme le serveur. Sur ordinateur, tableau avec le panneau des
	 * justificatifs à droite. Accords (imputation sur les derniers loyers : ce qui restera pour les dégâts, part gardée),
	 * contestation (la part non contestée se restitue sans attendre, jamais au-delà), restitution enregistrée (par
	 * l'organisation ou par le propriétaire qui détient la caution), clôture. Actions en ligne seulement.
	 */
	import { onMount } from 'svelte';
	import { CircleAlert, CircleCheck, FileText, Paperclip, Plus } from '@lucide/svelte';
	import { page } from '$app/state';
	import { formatDate, toIsoDate } from '@ziga/shared/dates';
	import { agreementPlan, DISPUTE_OUTCOMES } from '@ziga/shared/deposit-settlement';
	import {
		createAgreementSchema,
		createRepairSchema,
		decideAgreementSchema,
		disputeSchema,
		REFUND_METHODS,
		refundSchema
	} from '@ziga/shared/exit-schemas';
	import { newId } from '@ziga/shared/ids';
	import type { DepositAccountView, DepositMovementView, LeaseView, RentDueView } from '@ziga/shared/leases';
	import { formatFcfa, parseFcfa } from '@ziga/shared/money';
	import { can } from '@ziga/shared/permissions';
	import type { UnitView } from '@ziga/shared/properties';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import ReceiptPicker from '#lib/components/collections/ReceiptPicker.svelte';
	import DocumentVisibilityNotice from '#lib/components/portals/DocumentVisibilityNotice.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import Sheet from '#lib/components/ui/sheet/Sheet.svelte';
	import { messageOf } from '#lib/auth/forms.ts';
	import { device } from '#lib/device.svelte.ts';
	import { openDocument, uploadExitDocument } from '#lib/exit/documents.ts';
	import {
		currentLines,
		elementLabel,
		lineProof,
		toAgreement,
		toInspection,
		toItem,
		toLine,
		toRepair,
		toSettlement,
		type LocalAgreement,
		type LocalInspection,
		type LocalItem,
		type LocalLine,
		type LocalRepair,
		type LocalSettlement
	} from '#lib/exit/views.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { toDepositAccount, toLease, toMovement, toRentDue } from '#lib/leases/views.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { toUnit } from '#lib/properties/views.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';

	type Row = Record<string, unknown>;
	const t = fr.exit.settlement;
	const ta = fr.exit.agreements;
	const today = toIsoDate();
	const leaseId = $derived(page.params.id ?? '');
	const role = $derived(organizations.active?.role);
	const canSettle = $derived(can(role, 'deposit.settle'));
	const orgName = $derived(organizations.active?.name ?? '');

	let lease = $state<LeaseView | null>(null);
	let unit = $state<UnitView | null>(null);
	let accountRows = $state<Row[]>([]);
	let movements = $state<DepositMovementView[]>([]);
	let dues = $state<RentDueView[]>([]);
	let settlements = $state<LocalSettlement[]>([]);
	let lines = $state<LocalLine[]>([]);
	let repairs = $state<LocalRepair[]>([]);
	let agreements = $state<LocalAgreement[]>([]);
	let inspections = $state<LocalInspection[]>([]);
	let items = $state<LocalItem[]>([]);
	let loaded = $state(false);
	let message = $state<string | null>(null);
	let info = $state<string | null>(null);
	let busy = $state(false);

	onMount(() => {
		const org = organizations.activeId;
		const onError = (error: Error) => (message = messageOf(error));
		const stops = [
			sync.watch<Row>(LOCAL_QUERIES.lease, [org, leaseId], (r) => ((lease = r[0] ? toLease(r[0], false) : null), (loaded = true)), onError),
			sync.watch<Row>(LOCAL_QUERIES.leaseDeposits, [org, leaseId], (r) => (accountRows = r), onError),
			sync.watch<Row>(LOCAL_QUERIES.leaseMovements, [org, leaseId], (r) => (movements = r.map(toMovement)), onError),
			sync.watch<Row>(LOCAL_QUERIES.leaseDues, [org, leaseId], (r) => (dues = r.map((x) => toRentDue(x, today))), onError),
			sync.watch<Row>(LOCAL_QUERIES.leaseSettlements, [org, leaseId], (r) => (settlements = r.map(toSettlement)), onError),
			sync.watch<Row>(LOCAL_QUERIES.leaseSettlementLines, [org, leaseId], (r) => (lines = r.map(toLine)), onError),
			sync.watch<Row>(LOCAL_QUERIES.leaseRepairs, [org, leaseId], (r) => (repairs = r.map(toRepair)), onError),
			sync.watch<Row>(LOCAL_QUERIES.leaseAgreements, [org, leaseId], (r) => (agreements = r.map(toAgreement)), onError),
			sync.watch<Row>(LOCAL_QUERIES.leaseInspections, [org, leaseId], (r) => (inspections = r.map(toInspection)), onError),
			sync.watch<Row>(LOCAL_QUERIES.leaseInspectionItems, [org, leaseId], (r) => (items = r.map(toItem)), onError)
		];
		return () => stops.forEach((s) => s());
	});

	// Un abonnement par unité, jamais renouvelé à chaque nouvelle version du bail.
	const unitId = $derived(lease?.unitId ?? null);
	$effect(() => {
		const org = organizations.activeId;
		if (!unitId) return;
		return sync.watch<Row>(LOCAL_QUERIES.unit, [org, unitId], (r) => (unit = r[0] ? toUnit(r[0]) : null));
	});

	const accounts = $derived<DepositAccountView[]>(lease ? accountRows.map((r) => toDepositAccount(r, movements, lease!.rent)) : []);
	const account = $derived(accounts.find((a) => a.type === 'security_deposit') ?? accounts[0] ?? null);
	const settlement = $derived(account ? (settlements.filter((s) => s.depositAccountId === account.id).at(-1) ?? null) : null);
	const shown = $derived(settlement ? currentLines(settlement, lines) : []);
	const repairById = $derived(new Map(repairs.map((r) => [r.id, r])));
	const agreementById = $derived(new Map(agreements.map((a) => [a.id, a])));
	const itemById = $derived(new Map(items.map((i) => [i.id, i])));
	const exitInspection = $derived(inspections.find((i) => i.type === 'exit') ?? null);
	const damaged = $derived(
		exitInspection ? items.filter((i) => i.inspectionId === exitInspection.id && i.finding === 'tenant_damage') : []
	);
	const accountMovements = $derived(account ? movements.filter((m) => m.accountId === account.id) : []);
	const alreadyRefunded = $derived(accountMovements.filter((m) => m.type === 'refunded').reduce((s, m) => s + m.amount, 0));
	const refundRemaining = $derived(settlement ? Math.max(0, settlement.refund - alreadyRefunded) : 0);
	const ownerHolds = $derived(account?.holder === 'owner');
	const editable = $derived(canSettle && settlement?.status === 'draft');

	/** Libellé d'une ligne : l'élément constaté, le mois, la dépense. */
	function lineLabel(l: LocalLine): string {
		const kind = t.kinds[l.kind] ?? l.kind;
		if (l.kind === 'repair') {
			const r = l.repairId ? repairById.get(l.repairId) : undefined;
			const item = r ? itemById.get(r.inspectionItemId) : l.inspectionItemId ? itemById.get(l.inspectionItemId) : undefined;
			return `${kind} : ${item ? `${item.room} · ${elementLabel(item.element)}` : ''}${r ? ` — ${r.description}` : ''}`;
		}
		if (l.rentDueId) {
			const d = dues.find((x) => x.id === l.rentDueId);
			return d ? `${kind} : ${formatDate(d.periodStart)} – ${formatDate(d.periodEnd)}` : kind;
		}
		return kind;
	}

	async function act(fn: () => Promise<unknown>, done: string = fr.exit.saved) {
		message = null;
		info = null;
		busy = true;
		try {
			await fn();
			info = done;
			return true;
		} catch (error) {
			message = messageOf(error);
			return false;
		} finally {
			busy = false;
		}
	}

	const prepare = () => act(() => organizations.call('POST', `/deposit-accounts/${account!.id}/settlement`));
	/** Après une réparation ou un accord, le brouillon est recalculé par le serveur (nouvelle révision). */
	async function refreshDraft() {
		if (settlement?.status === 'draft' && account) await organizations.call('POST', `/deposit-accounts/${account.id}/settlement`);
	}

	// ---- réparation (retenue) : montant et justificatif exigés, comme le serveur
	let repairOpen = $state(false);
	let repairItem = $state('');
	let repairDescription = $state('');
	let repairAmount = $state('');
	let repairPerformer = $state<'organization' | 'tenant'>('organization');
	let repairAgreement = $state('');
	let repairFiles = $state<File[]>([]);
	const selfRepairAgreements = $derived(agreements.filter((a) => a.type === 'tenant_self_repair' && a.status === 'accepted'));
	const repairAmountValue = $derived(parseFcfa(repairAmount));
	const repairJustified = $derived(
		repairPerformer === 'organization' ? !!repairAmountValue && repairAmountValue > 0 && repairFiles.length > 0 : !!repairAgreement
	);

	function openRepair(itemId?: string) {
		repairItem = itemId ?? damaged.find((d) => !repairs.some((r) => r.inspectionItemId === d.id))?.id ?? damaged[0]?.id ?? '';
		repairDescription = '';
		repairAmount = '';
		repairPerformer = 'organization';
		repairAgreement = '';
		repairFiles = [];
		repairOpen = true;
	}

	async function saveRepair(event: SubmitEvent) {
		event.preventDefault();
		if (!repairJustified) return void (message = t.repairRefused);
		const ok = await act(async () => {
			const quoteDocumentId = repairFiles.length
				? await uploadExitDocument(
						'repair_quote',
						{ leaseId, propertyId: unit?.propertyId, unitId: unit?.id },
						repairFiles,
						'Devis de réparation'
					)
				: null;
			const parsed = createRepairSchema.parse({
				id: newId(),
				inspectionItemId: repairItem,
				description: repairDescription,
				performedBy: repairPerformer,
				estimatedAmount: repairAmountValue,
				quoteDocumentId,
				agreementId: repairAgreement || null
			});
			await organizations.call('POST', '/repairs', parsed);
			await refreshDraft();
		});
		if (ok) repairOpen = false;
	}

	// ---- accords
	let agreementOpen = $state(false);
	let agreementType = $state<'deposit_applied_to_rent' | 'tenant_self_repair'>('deposit_applied_to_rent');
	let agreementMonths = $state<string[]>([]);
	let agreementKeep = $state('');
	let agreementProposedBy = $state<'tenant' | 'organization' | 'owner'>('tenant');
	let agreementProposedOn = $state(today);
	let agreementText = $state('');
	const openDues = $derived(dues.filter((d) => d.status !== 'waived' && d.status !== 'paid' && d.balance > 0));
	/** Mois proposés pour une imputation sur loyer : jamais le « Solde antérieur » d'un import (un impayé, pas un mois). */
	const agreementDues = $derived(openDues.filter((d) => d.kind !== 'opening_balance'));
	const held = $derived(settlement ? settlement.received - alreadyRefunded : (account?.balances.held ?? 0));
	const plan = $derived(
		agreementPlan({
			held,
			keep: Math.min(parseFcfa(agreementKeep) ?? 0, held),
			months: agreementDues
				.filter((d) => agreementMonths.includes(d.periodStart))
				.map((d) => ({ periodStart: d.periodStart, outstanding: d.balance }))
		})
	);

	function openAgreement(type: typeof agreementType) {
		agreementType = type;
		agreementMonths = type === 'deposit_applied_to_rent' && agreementDues.at(-1) ? [agreementDues.at(-1)!.periodStart] : [];
		agreementKeep = '';
		agreementProposedBy = 'tenant';
		agreementProposedOn = today;
		agreementText = '';
		agreementOpen = true;
	}

	async function saveAgreement(event: SubmitEvent) {
		event.preventDefault();
		const parsed = createAgreementSchema.safeParse({
			id: newId(),
			leaseId,
			type: agreementType,
			proposedBy: agreementProposedBy,
			proposedOn: agreementProposedOn,
			description: agreementText,
			months: agreementType === 'deposit_applied_to_rent' ? agreementMonths : [],
			keptAmount: agreementType === 'deposit_applied_to_rent' ? Math.min(parseFcfa(agreementKeep) ?? 0, held) : 0
		});
		if (!parsed.success) return void (message = parsed.error.issues[0]!.message);
		const ok = await act(async () => {
			await organizations.call('POST', '/agreements', parsed.data);
			await refreshDraft();
		});
		if (ok) agreementOpen = false;
	}

	let decideOf = $state<LocalAgreement | null>(null);
	let decideOpen = $state(false);
	let decision = $state<'accepted' | 'refused'>('accepted');
	let decidedByParty = $state<'organization' | 'tenant' | 'owner'>('organization');
	let decidedOn = $state(today);
	let refusalReason = $state('');
	let decisionFiles = $state<File[]>([]);

	function openDecision(a: LocalAgreement, d: 'accepted' | 'refused') {
		decideOf = a;
		decision = d;
		decidedByParty = a.proposedBy === 'tenant' ? 'organization' : 'tenant';
		decidedOn = today;
		refusalReason = '';
		decisionFiles = [];
		decideOpen = true;
	}

	async function saveDecision(event: SubmitEvent) {
		event.preventDefault();
		if (!decideOf) return;
		const a = decideOf;
		const ok = await act(async () => {
			const documentId = decisionFiles.length
				? await uploadExitDocument('agreement_document', { leaseId }, decisionFiles, 'Accord écrit')
				: null;
			const parsed = decideAgreementSchema.parse({ decision, decidedByParty, decidedOn, reason: refusalReason, documentId });
			await organizations.call('POST', `/agreements/${a.id}/decision`, parsed);
			await refreshDraft();
		});
		if (ok) decideOpen = false;
	}

	// ---- contestation, restitution, clôture
	let disputeOpen = $state(false);
	let disputeParty = $state<'tenant' | 'organization' | 'owner'>('tenant');
	let observations = $state('');

	async function saveDispute(event: SubmitEvent) {
		event.preventDefault();
		const parsed = disputeSchema.safeParse({ party: disputeParty, observations });
		if (!parsed.success) return void (message = parsed.error.issues[0]!.message);
		if (await act(() => organizations.call('POST', `/deposit-settlements/${settlement!.id}/dispute`, parsed.data), t.disputed))
			disputeOpen = false;
	}

	let refundOpen = $state(false);
	let refundMode = $state<'partial' | 'close'>('close');
	let refundAmount = $state('');
	let refundOn = $state(today);
	let refundedBy = $state<'organization' | 'owner'>('organization');
	let refundMethod = $state<(typeof REFUND_METHODS)[number]>('cash');
	let refundReference = $state('');
	let outcome = $state<(typeof DISPUTE_OUTCOMES)[number]>('amicable_agreement');
	let outcomeFiles = $state<File[]>([]);

	function openRefund(mode: 'partial' | 'close') {
		refundMode = mode;
		refundAmount = mode === 'partial' ? String(refundRemaining) : '';
		refundOn = today;
		refundedBy = ownerHolds ? 'owner' : 'organization';
		refundMethod = 'cash';
		refundReference = '';
		outcomeFiles = [];
		refundOpen = true;
	}

	async function saveRefund(event: SubmitEvent) {
		event.preventDefault();
		if (!settlement) return;
		const s = settlement;
		const details = { id: newId(), refundedOn: refundOn, refundedBy, method: refundMethod, reference: refundReference };
		if (refundMode === 'partial') {
			const parsed = refundSchema.safeParse({ ...details, amount: parseFcfa(refundAmount) ?? 0 });
			if (!parsed.success) return void (message = parsed.error.issues[0]!.message);
			if (await act(() => organizations.call('POST', `/deposit-settlements/${s.id}/refunds`, parsed.data))) refundOpen = false;
			return;
		}
		const ok = await act(
			async () => {
				const disputed = s.status === 'disputed';
				const documentId =
					disputed && outcomeFiles.length
						? await uploadExitDocument('settlement_outcome', { leaseId }, outcomeFiles, 'Issue de la contestation')
						: null;
				await organizations.call('POST', `/deposit-settlements/${s.id}/close`, {
					refund: refundRemaining > 0 ? details : null,
					disputeOutcome: disputed ? outcome : null,
					documentId
				});
			},
			t.closed(formatDate(today))
		);
		if (ok) refundOpen = false;
	}

	const select = 'min-h-11 w-full rounded-lg border bg-background px-3 text-base';
	const field = 'space-y-1';
</script>

{#snippet proof(l: LocalLine)}
	{@const p = lineProof(l, { repairs: repairById, agreements: agreementById })}
	{#if p.missing}
		<span class="flex items-start gap-1 text-base text-destructive" data-testid="justificatif-manquant"
			><CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />{t.missing(t.blockers[p.missing] ?? p.missing)}</span
		>
	{:else if p.documentId}
		{#if can(role, 'document.read')}
			<Button
				variant="outline"
				onclick={() => act(() => openDocument(p.documentId!), '')}
				disabled={!sync.online}
				data-testid="voir-justificatif"><Paperclip class="size-4" aria-hidden="true" />{t.viewProof}</Button
			>
		{:else}
			<span class="flex items-center gap-1 text-base"><Paperclip class="size-4" aria-hidden="true" />{t.proof}</span>
		{/if}
	{:else}
		<span class="text-base text-muted-foreground">—</span>
	{/if}
{/snippet}

{#snippet kept(l: LocalLine)}
	{#if l.blocker}<Badge variant="danger">{t.notKept}</Badge>{:else}<Badge variant="success">{t.kept}</Badge>{/if}
{/snippet}

<PageHeader title={t.title} back="app/sorties" backLabel={fr.exit.back} />

<main class="page space-y-4 pt-3 pb-10" data-testid="decompte">
	<FormAlert {message} />
	<FormAlert message={info} tone="info" />
	{#if !can(role, 'deposit.read')}
		<FormAlert message={fr.app.notFound} />
	{:else if loaded && !lease}
		<FormAlert message={fr.exit.notFound} />
	{:else if lease && !account}
		<p class="rounded-xl border bg-card p-4 text-base">{fr.exit.hub.noDeposit}</p>
	{:else if lease && account}
		<p class="text-base text-muted-foreground">{ownerHolds ? t.holder.owner : t.holder.organization(orgName)}</p>
		{#if !settlement}
			<section class="space-y-3 rounded-xl border bg-card p-4">
				<p class="text-base">{t.received} : <strong class="tabular-nums">{formatFcfa(account.balances.held)}</strong></p>
				{#if canSettle}
					<Button onclick={prepare} disabled={busy || !sync.online} data-testid="preparer-decompte">{t.prepare}</Button>
					{#if !sync.online}<p class="text-sm text-muted-foreground">{fr.exit.onlineOnly}</p>{/if}
				{/if}
			</section>
		{:else}
			<div class="space-y-4 xl:grid xl:grid-cols-[minmax(0,1fr)_24rem] xl:items-start xl:gap-6 xl:space-y-0">
				<div class="space-y-4">
					<section class="space-y-3 rounded-xl border bg-card p-4" aria-labelledby="titre-lignes" data-testid="lignes-decompte">
						<div class="flex flex-wrap items-center justify-between gap-2">
							<h2 id="titre-lignes" class="text-lg font-semibold">{t.title}</h2>
							<Badge
								variant={settlement.status === 'closed' ? 'success' : settlement.status === 'disputed' ? 'danger' : 'info'}
								data-testid="statut-decompte"
								>{fr.exit.stages[
									settlement.status === 'closed' ? 'closed' : settlement.status === 'disputed' ? 'disputed' : 'settlement'
								]}</Badge
							>
						</div>
						{#if settlement.refundDeadline && settlement.status !== 'closed'}
							<p class="text-base">
								{t.deadline(formatDate(settlement.refundDeadline))}{#if settlement.refundAlert}
									· <Badge variant="danger">{fr.exit.refundAlert[settlement.refundAlert]}</Badge>{/if}
							</p>
						{/if}
						{#if !shown.length}
							<p class="text-base text-muted-foreground">{t.noLines}</p>
						{:else if device.isDesktop}
							<div class="overflow-x-auto">
								<table class="w-full text-left text-base">
									<thead class="border-b text-muted-foreground">
										<tr>
											<th class="py-2 pr-3 font-medium">{t.columns.line}</th>
											<th class="py-2 pr-3 text-right font-medium">{t.columns.amount}</th>
											<th class="py-2 pr-3 font-medium">{t.columns.status}</th>
										</tr>
									</thead>
									<tbody class="divide-y">
										{#each shown as l (l.id)}
											<tr data-testid="ligne-decompte" data-kept={l.blocker ? 'non' : 'oui'}>
												<td class="py-3 pr-3">{lineLabel(l)}</td>
												<td class="py-3 pr-3 text-right whitespace-nowrap tabular-nums">{l.blocker ? '—' : `− ${formatFcfa(l.amount)}`}</td>
												<td class="py-3 pr-3">{@render kept(l)}</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						{:else}
							<ul class="space-y-2">
								{#each shown as l (l.id)}
									<li class="space-y-2 rounded-lg border p-3" data-testid="ligne-decompte" data-kept={l.blocker ? 'non' : 'oui'}>
										<p class="flex flex-wrap items-start justify-between gap-2">
											<span class="min-w-0 break-words">{lineLabel(l)}</span>
											<span class="font-semibold whitespace-nowrap tabular-nums">{l.blocker ? '—' : `− ${formatFcfa(l.amount)}`}</span>
										</p>
										<div class="flex flex-wrap items-center gap-2">{@render kept(l)}{@render proof(l)}</div>
									</li>
								{/each}
							</ul>
						{/if}
						<dl class="space-y-1 border-t pt-3 text-base">
							<div class="flex justify-between gap-3">
								<dt>{t.received}</dt>
								<dd class="font-semibold tabular-nums" data-testid="caution-recue">{formatFcfa(settlement.received)}</dd>
							</div>
							{#if settlement.credit > 0}<div class="flex justify-between gap-3">
									<dt>{t.credit}</dt>
									<dd class="tabular-nums">+ {formatFcfa(settlement.credit)}</dd>
								</div>{/if}
							<div class="flex justify-between gap-3">
								<dt>{t.deductions}</dt>
								<dd class="tabular-nums">− {formatFcfa(settlement.deductions)}</dd>
							</div>
						</dl>
						{#if settlement.claim > 0}
							<p class="text-base text-muted-foreground">{t.claim}</p>
							<p class="text-3xl font-bold text-destructive" data-testid="a-reclamer">{formatFcfa(settlement.claim)}</p>
						{/if}
						<p class="text-base text-muted-foreground">{settlement.outcome === 'zero' ? t.zero : t.refund}</p>
						<p class="text-3xl font-bold text-primary" data-testid="a-restituer">{formatFcfa(settlement.refund)}</p>
						{#if alreadyRefunded > 0}<p class="text-base" data-testid="deja-restitue">
								{t.alreadyRefunded(formatFcfa(alreadyRefunded))}
							</p>{/if}
					</section>

					{#if editable}
						<section class="space-y-2 rounded-xl border bg-card p-4" aria-labelledby="titre-reparations">
							<h2 id="titre-reparations" class="text-lg font-semibold">{t.addRepair}</h2>
							{#if !damaged.length}
								<p class="text-base text-muted-foreground">{t.noDamage}</p>
							{:else}
								<Button variant="outline" onclick={() => openRepair()} data-testid="chiffrer-reparation"
									><Plus class="size-5" aria-hidden="true" />{t.addRepair}</Button
								>
							{/if}
						</section>
					{/if}

					<section class="space-y-3 rounded-xl border bg-card p-4" aria-labelledby="titre-accords" data-testid="accords">
						<h2 id="titre-accords" class="text-lg font-semibold">{ta.title}</h2>
						<p class="text-base text-muted-foreground">{ta.hint}</p>
						<ul class="space-y-2">
							{#each agreements as a (a.id)}
								<li class="space-y-2 rounded-lg border p-3" data-testid="accord">
									<p class="flex flex-wrap items-center justify-between gap-2">
										<span class="font-medium">{ta.types[a.type]}</span>
										<Badge variant={a.status === 'accepted' ? 'success' : a.status === 'refused' ? 'danger' : 'warning'}
											>{ta.statuses[a.status]}</Badge
										>
									</p>
									<p class="text-sm text-muted-foreground">
										{ta.proposedBy(ta.parties[a.proposedBy] ?? a.proposedBy, formatDate(a.proposedOn))}
									</p>
									{#if a.months.length}<p class="text-base">{ta.months} : {a.months.map((m) => formatDate(m)).join(', ')}</p>{/if}
									{#if a.keptAmount > 0}<p class="text-base">{ta.keep} : {formatFcfa(a.keptAmount)}</p>{/if}
									{#if a.description}<p class="text-base break-words">{a.description}</p>{/if}
									{#if a.decidedOn && a.decidedByParty}<p class="text-sm text-muted-foreground">
											{ta.decided(ta.statuses[a.status]!, ta.parties[a.decidedByParty] ?? '', formatDate(a.decidedOn))}
										</p>{/if}
									{#if a.status === 'proposed' && can(role, 'agreement.decide')}
										<div class="flex flex-wrap gap-2">
											<Button onclick={() => openDecision(a, 'accepted')} disabled={!sync.online} data-testid="accepter-accord"
												>{ta.accept}</Button
											>
											<Button variant="outline" onclick={() => openDecision(a, 'refused')} disabled={!sync.online}>{ta.refuse}</Button>
										</div>
									{/if}
								</li>
							{:else}
								<li class="text-base text-muted-foreground">{ta.empty}</li>
							{/each}
						</ul>
						{#if canSettle && settlement.status !== 'closed'}
							<div class="flex flex-wrap gap-2">
								<Button
									variant="outline"
									onclick={() => openAgreement('deposit_applied_to_rent')}
									disabled={!sync.online}
									data-testid="nouvel-accord-loyer">{ta.newRent}</Button
								>
								<Button variant="outline" onclick={() => openAgreement('tenant_self_repair')} disabled={!sync.online}
									>{ta.newSelfRepair}</Button
								>
							</div>
						{/if}
					</section>

					{#if canSettle && settlement.status !== 'closed'}
						<section class="flex flex-wrap gap-2 rounded-xl border bg-card p-4" aria-label={t.title} data-testid="actions-decompte">
							{#if settlement.status === 'draft'}
								<Button variant="outline" onclick={prepare} disabled={busy || !sync.online}>{t.refresh}</Button>
								<Button
									onclick={() => act(() => organizations.call('POST', `/deposit-settlements/${settlement!.id}/propose`))}
									disabled={busy || !sync.online}
									data-testid="proposer-decompte">{t.propose}</Button
								>
							{:else if settlement.status === 'proposed'}
								<Button
									onclick={() => act(() => organizations.call('POST', `/deposit-settlements/${settlement!.id}/accept`))}
									disabled={busy || !sync.online}
									data-testid="accepter-decompte">{t.accept}</Button
								>
							{/if}
							{#if settlement.status === 'proposed' || settlement.status === 'accepted'}
								<Button
									variant="outline"
									onclick={() => ((disputeOpen = true), (observations = ''))}
									disabled={!sync.online}
									data-testid="contester-decompte">{t.dispute}</Button
								>
							{/if}
							{#if settlement.status === 'disputed'}
								<p class="w-full text-base">{t.disputed}</p>
								{#if settlement.tenantObservations}<p class="w-full text-base break-words">
										{ta.parties.tenant} : {settlement.tenantObservations}
									</p>{/if}
								{#if refundRemaining > 0}
									<p class="w-full text-base font-medium" data-testid="part-non-contestee">{t.undisputed(formatFcfa(refundRemaining))}</p>
									<Button onclick={() => openRefund('partial')} disabled={!sync.online} data-testid="restituer-part"
										>{t.partialRefund}</Button
									>
								{/if}
								<Button variant="outline" onclick={() => openRefund('close')} disabled={!sync.online} data-testid="clore-issue"
									>{t.closeWithOutcome}</Button
								>
							{/if}
							{#if settlement.status === 'accepted'}
								<Button onclick={() => openRefund('close')} disabled={!sync.online} data-testid="clore-decompte">{t.close}</Button>
							{/if}
							{#if !sync.online}<p class="w-full text-sm text-muted-foreground">{fr.exit.onlineOnly}</p>{/if}
						</section>
					{/if}
					{#if settlement.status === 'closed' && settlement.closedAt}
						<p class="flex items-center gap-2 rounded-xl border bg-card p-4 text-lg font-semibold" data-testid="sortie-close">
							<CircleCheck class="size-6 text-primary" aria-hidden="true" />{t.closed(formatDate(settlement.closedAt))}
						</p>
					{/if}
				</div>

				<aside class="space-y-4">
					{#if device.isDesktop && shown.length}
						<section
							class="space-y-3 rounded-xl border bg-card p-4"
							aria-labelledby="titre-justificatifs"
							data-testid="panneau-justificatifs"
						>
							<h2 id="titre-justificatifs" class="flex items-center gap-2 text-lg font-semibold">
								<FileText class="size-5" aria-hidden="true" />{t.proofPanel}
							</h2>
							<p class="text-sm text-muted-foreground">{t.proofPanelHint}</p>
							<ul class="space-y-3">
								{#each shown as l (l.id)}
									<li class="space-y-1 border-t pt-2 first:border-t-0 first:pt-0">
										<p class="text-base font-medium break-words">{lineLabel(l)}</p>
										{@render proof(l)}
									</li>
								{/each}
							</ul>
						</section>
					{/if}
					<section class="space-y-2 rounded-xl border bg-card p-4" aria-labelledby="titre-mouvements" data-testid="mouvements-caution">
						<h2 id="titre-mouvements" class="text-lg font-semibold">{t.movements}</h2>
						<p class="text-sm text-muted-foreground">{t.movementsHint}</p>
						<ol class="space-y-2">
							{#each accountMovements as m (m.id)}
								<li class="rounded-lg bg-muted p-2 text-base" data-testid="mouvement">
									<span class="font-medium">{fr.leases.movementTypes[m.type] ?? m.type}</span> ·
									<span class="tabular-nums">{formatFcfa(m.amount)}</span>
									· {formatDate(m.occurredOn)}
									{#if m.reason}<span class="block text-sm break-words text-muted-foreground">{m.reason}</span>{/if}
								</li>
							{/each}
						</ol>
					</section>
				</aside>
			</div>
		{/if}
	{/if}
</main>

<Sheet bind:open={repairOpen} labelledby="reparation-titre" side="right">
	<form class="space-y-4" onsubmit={saveRepair} novalidate data-testid="formulaire-reparation">
		<h2 id="reparation-titre" class="pr-10 text-xl font-semibold">{t.addRepair}</h2>
		<FormAlert {message} />
		<div class={field}>
			<label for="reparation-element" class="text-base font-medium">{t.repairItem}</label>
			<select id="reparation-element" class={select} bind:value={repairItem}>
				{#each damaged as d (d.id)}<option value={d.id}>{d.room} · {elementLabel(d.element)}</option>{/each}
			</select>
		</div>
		<div class={field}>
			<label for="reparation-description" class="text-base font-medium">{t.repairDescription}</label>
			<Input id="reparation-description" bind:value={repairDescription} maxlength={500} data-testid="reparation-description" />
		</div>
		<fieldset class="space-y-2">
			<legend class="text-base font-medium">{t.repairPerformer}</legend>
			{#each ['organization', 'tenant'] as const as p (p)}
				<label class="flex min-h-11 items-center gap-3 rounded-lg border-2 bg-card px-3 py-2 has-checked:border-primary">
					<input type="radio" name="reparateur" value={p} bind:group={repairPerformer} class="size-5 shrink-0" />{t.performers[p]}
				</label>
			{/each}
		</fieldset>
		{#if repairPerformer === 'tenant'}
			<div class={field}>
				<label for="reparation-accord" class="text-base font-medium">{ta.types.tenant_self_repair}</label>
				<select id="reparation-accord" class={select} bind:value={repairAgreement}>
					<option value="">—</option>
					{#each selfRepairAgreements as a (a.id)}<option value={a.id}
							>{ta.proposedBy(ta.parties[a.proposedBy] ?? '', formatDate(a.proposedOn))}</option
						>{/each}
				</select>
			</div>
		{/if}
		<div class={field}>
			<label for="reparation-montant" class="text-base font-medium">{t.repairAmount}</label>
			<Input id="reparation-montant" inputmode="numeric" bind:value={repairAmount} class="tabular-nums" data-testid="reparation-montant" />
		</div>
		<ReceiptPicker bind:files={repairFiles} title={t.repairQuote} hint={t.proofPanelHint} testid="reparation-devis" />
		<DocumentVisibilityNotice type="repair_quote" />
		{#if !repairJustified}<p class="flex items-start gap-2 text-base text-destructive" role="status" data-testid="retenue-impossible">
				<CircleAlert class="mt-0.5 size-5 shrink-0" aria-hidden="true" />{t.repairRefused}
			</p>{/if}
		<Button type="submit" class="w-full" disabled={busy || !repairJustified || !sync.online} data-testid="enregistrer-reparation"
			>{t.repairSubmit}</Button
		>
	</form>
</Sheet>

<Sheet bind:open={agreementOpen} labelledby="accord-titre" side="right">
	<form class="space-y-4" onsubmit={saveAgreement} novalidate data-testid="formulaire-accord">
		<h2 id="accord-titre" class="pr-10 text-xl font-semibold">{ta.types[agreementType]}</h2>
		<FormAlert {message} />
		{#if agreementType === 'deposit_applied_to_rent'}
			<fieldset class="space-y-2">
				<legend class="text-base font-medium">{ta.months}</legend>
				{#each agreementDues as d (d.id)}
					<label class="flex min-h-11 items-center gap-3">
						<input type="checkbox" class="size-5" value={d.periodStart} bind:group={agreementMonths} />{formatDate(d.periodStart)} – {formatDate(
							d.periodEnd
						)} · {formatFcfa(d.balance)}
					</label>
				{/each}
			</fieldset>
			<div class={field}>
				<label for="accord-garde" class="text-base font-medium">{ta.keep}</label>
				<Input id="accord-garde" inputmode="numeric" bind:value={agreementKeep} class="tabular-nums" data-testid="accord-garde" />
			</div>
			<div class="space-y-1 rounded-lg bg-warning-soft p-3 text-base text-warning-foreground" role="status" data-testid="reste-degats">
				<p>{ta.plan(formatFcfa(plan.applied), formatFcfa(plan.remainingForDamage))}</p>
				{#if plan.nothingLeft}<p class="font-medium">{ta.nothingLeft}</p>{/if}
				{#each plan.months.filter((m) => m.uncovered > 0) as m (m.periodStart)}<p>
						{ta.uncovered(formatDate(m.periodStart), formatFcfa(m.uncovered))}
					</p>{/each}
			</div>
			<p class="text-sm text-muted-foreground">{ta.beforeMonths}</p>
		{/if}
		<div class="grid gap-3 sm:grid-cols-2">
			<div class={field}>
				<label for="accord-par" class="text-base font-medium">{ta.proposer}</label>
				<select id="accord-par" class={select} bind:value={agreementProposedBy}>
					<option value="tenant">{fr.exit.notice.origins.tenant}</option>
					<option value="organization">{orgName}</option>
					<option value="owner">{ta.parties.owner}</option>
				</select>
			</div>
			<div class={field}>
				<label for="accord-date" class="text-base font-medium">{ta.proposedOn}</label>
				<Input id="accord-date" type="date" bind:value={agreementProposedOn} max={today} />
			</div>
		</div>
		<div class={field}>
			<label for="accord-texte" class="text-base font-medium">{ta.description}</label>
			<textarea
				id="accord-texte"
				class="min-h-20 w-full rounded-lg border bg-background p-3 text-base"
				maxlength={1000}
				bind:value={agreementText}></textarea>
		</div>
		<Button type="submit" class="w-full" disabled={busy || !sync.online} data-testid="enregistrer-accord">{ta.submit}</Button>
	</form>
</Sheet>

<Sheet bind:open={decideOpen} labelledby="decision-titre" side="right">
	<form class="space-y-4" onsubmit={saveDecision} novalidate data-testid="formulaire-decision">
		<h2 id="decision-titre" class="pr-10 text-xl font-semibold">{decision === 'accepted' ? ta.accept : ta.refuse}</h2>
		<FormAlert {message} />
		<div class="grid gap-3 sm:grid-cols-2">
			<div class={field}>
				<label for="decision-par" class="text-base font-medium">{ta.decidedBy}</label>
				<select id="decision-par" class={select} bind:value={decidedByParty}>
					<option value="organization">{orgName}</option>
					<option value="tenant">{fr.exit.notice.origins.tenant}</option>
					<option value="owner">{ta.parties.owner}</option>
				</select>
			</div>
			<div class={field}>
				<label for="decision-date" class="text-base font-medium">{ta.decidedOn}</label>
				<Input id="decision-date" type="date" bind:value={decidedOn} max={today} />
			</div>
		</div>
		{#if decision === 'refused'}
			<div class={field}>
				<label for="decision-motif" class="text-base font-medium">{ta.refusalReason}</label>
				<Input id="decision-motif" bind:value={refusalReason} maxlength={500} />
			</div>
		{/if}
		<ReceiptPicker bind:files={decisionFiles} title={ta.document} hint={ta.hint} testid="accord-document" />
		<DocumentVisibilityNotice type="agreement_document" />
		<Button type="submit" class="w-full" disabled={busy || !sync.online} data-testid="enregistrer-decision">{ta.decide}</Button>
	</form>
</Sheet>

<Sheet bind:open={disputeOpen} labelledby="contestation-titre" side="right">
	<form class="space-y-4" onsubmit={saveDispute} novalidate data-testid="formulaire-contestation">
		<h2 id="contestation-titre" class="pr-10 text-xl font-semibold">{t.dispute}</h2>
		<FormAlert {message} />
		<div class={field}>
			<label for="contestation-partie" class="text-base font-medium">{fr.exit.inspection.disputeParty}</label>
			<select id="contestation-partie" class={select} bind:value={disputeParty}>
				<option value="tenant">{fr.exit.notice.origins.tenant}</option>
				<option value="owner">{ta.parties.owner}</option>
				<option value="organization">{orgName}</option>
			</select>
		</div>
		<div class={field}>
			<label for="contestation-observations" class="text-base font-medium">{fr.exit.inspection.observations}</label>
			<textarea
				id="contestation-observations"
				class="min-h-24 w-full rounded-lg border bg-background p-3 text-base"
				maxlength={2000}
				bind:value={observations}
				data-testid="contestation-observations"></textarea>
		</div>
		<Button type="submit" class="w-full" disabled={busy || !sync.online} data-testid="enregistrer-contestation"
			>{fr.exit.inspection.disputeSubmit}</Button
		>
	</form>
</Sheet>

<Sheet bind:open={refundOpen} labelledby="restitution-titre" side="right">
	<form class="space-y-4" onsubmit={saveRefund} novalidate data-testid="formulaire-restitution">
		<h2 id="restitution-titre" class="pr-10 text-xl font-semibold">
			{refundMode === 'partial' ? t.partialRefund : settlement?.status === 'disputed' ? t.closeWithOutcome : t.close}
		</h2>
		<FormAlert {message} />
		{#if refundMode === 'partial'}
			<div class={field}>
				<label for="restitution-montant" class="text-base font-medium">{t.refundAmount}</label>
				<Input
					id="restitution-montant"
					inputmode="numeric"
					bind:value={refundAmount}
					class="tabular-nums"
					data-testid="restitution-montant"
				/>
				<p class="text-sm text-muted-foreground">{t.undisputed(formatFcfa(refundRemaining))}</p>
			</div>
		{:else if settlement?.status === 'disputed'}
			<div class={field}>
				<label for="restitution-issue" class="text-base font-medium">{fr.exit.inspection.outcome}</label>
				<select id="restitution-issue" class={select} bind:value={outcome}>
					{#each DISPUTE_OUTCOMES as o (o)}<option value={o}>{fr.exit.inspection.outcomes[o]}</option>{/each}
				</select>
			</div>
			<ReceiptPicker
				bind:files={outcomeFiles}
				title={fr.exit.inspection.outcomeDocument}
				hint={fr.exit.inspection.disputed}
				testid="issue-document"
			/>
			<DocumentVisibilityNotice type="settlement_outcome" />
		{/if}
		{#if refundMode === 'partial' || refundRemaining > 0}
			<p class="text-base font-medium">{t.refundForm}{refundMode === 'close' ? ` : ${formatFcfa(refundRemaining)}` : ''}</p>
			<div class={field}>
				<label for="restitution-date" class="text-base font-medium">{t.refundOn}</label>
				<Input id="restitution-date" type="date" bind:value={refundOn} max={today} />
			</div>
			<fieldset class="space-y-2">
				<legend class="text-base font-medium">{t.refundedBy}</legend>
				<label class="flex min-h-11 items-center gap-3 rounded-lg border-2 bg-card px-3 py-2 has-checked:border-primary">
					<input
						type="radio"
						name="restitue-par"
						value="organization"
						bind:group={refundedBy}
						disabled={ownerHolds}
						class="size-5 shrink-0"
					/>{t.refundedByOptions.organization(orgName)}
				</label>
				<label class="flex min-h-11 items-center gap-3 rounded-lg border-2 bg-card px-3 py-2 has-checked:border-primary">
					<input type="radio" name="restitue-par" value="owner" bind:group={refundedBy} disabled={!ownerHolds} class="size-5 shrink-0" />{t
						.refundedByOptions.owner}
				</label>
			</fieldset>
			<div class={field}>
				<label for="restitution-moyen" class="text-base font-medium">{t.method}</label>
				<select id="restitution-moyen" class={select} bind:value={refundMethod}>
					{#each REFUND_METHODS as m (m)}<option value={m}>{t.methods[m]}</option>{/each}
				</select>
			</div>
			<div class={field}>
				<label for="restitution-reference" class="text-base font-medium">{t.reference}</label>
				<Input id="restitution-reference" bind:value={refundReference} maxlength={60} />
			</div>
		{/if}
		<Button type="submit" class="w-full" disabled={busy || !sync.online} data-testid="enregistrer-restitution"
			>{refundMode === 'partial' ? t.refundSubmit : settlement?.status === 'disputed' ? t.closeWithOutcome : t.close}</Button
		>
	</form>
</Sheet>
