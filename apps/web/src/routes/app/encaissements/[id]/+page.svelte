<script lang="ts">
	/**
	 * Encaissement et son reçu (lot 09), lus sur l'appareil. Le reçu émis par le serveur (copie figée, numéro) s'affiche
	 * tel quel ; avant la confirmation, l'appareil montre le reçu provisoire (imputation prévisionnelle, mêmes mentions),
	 * avec le QR code de vérification et le lien partagé créés sur cet appareil, hors ligne compris.
	 * Actions : partager (partage natif, WhatsApp, copier), imprimer, PDF A6 ou ticket (en ligne), valider ou rapprocher
	 * (direction et gestion, en ligne), annuler par contre-écriture (directeur, motif obligatoire, en ligne).
	 * Téléphone : le reçu, puis les boutons ; tablette et ordinateur : le reçu et un panneau d'actions à droite.
	 */
	import { onMount } from 'svelte';
	import { Ban, CircleCheck, Copy, FileDown, Link2, MessageCircle, Printer, Share2 } from '@lucide/svelte';
	import { page } from '$app/state';
	import { toIsoDate } from '@ziga/shared/dates';
	import { formatFcfa } from '@ziga/shared/money';
	import { cancelPaymentSchema } from '@ziga/shared/payments';
	import { can } from '@ziga/shared/permissions';
	import { formatPhone } from '@ziga/shared/phone';
	import type { PaymentValidationResult, ReceiptFormat, ReceiptOrganizationSnapshot } from '@ziga/shared/receipts';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import ReceiptDocumentView from '#lib/components/payments/ReceiptDocumentView.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { Sheet } from '#lib/components/ui/sheet/index.ts';
	import { auth } from '#lib/auth/auth.svelte.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { toDepositAccount, toMovement, toRentDue, toTenant } from '#lib/leases/views.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { statusTone } from '#lib/payments/tones.ts';
	import {
		localSnapshot,
		receiptToShow,
		shareText,
		shareUrl,
		toDraft,
		toPayment,
		toReceipt,
		whatsappLink,
		type DueForScreen,
		type LocalPayment,
		type LocalReceipt,
		type ReceiptDraft
	} from '#lib/payments/views.ts';
	import { GEOGRAPHY_QUERIES, LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';
	import { toOrganizationView } from '#lib/sync/views.ts';
	import { cn } from '#lib/utils.ts';

	type Row = Record<string, unknown>;
	const t = fr.payments;
	const today = toIsoDate();
	const id = $derived(page.params.id ?? '');
	const role = $derived(organizations.active?.role);
	const origin = typeof location === 'undefined' ? '' : location.origin;

	let payment = $state<LocalPayment | null>(null);
	let receipt = $state<LocalReceipt | null>(null);
	let draft = $state<ReceiptDraft | null>(null);
	let loaded = $state(false);
	let orgRow = $state<Row | null>(null);
	let leaseRow = $state<Row | null>(null);
	let tenantRow = $state<Row | null>(null);
	let unitRow = $state<Row | null>(null);
	let propertyRow = $state<Row | null>(null);
	let dueRows = $state<Row[]>([]);
	let accountRows = $state<Row[]>([]);
	let movementRows = $state<Row[]>([]);
	let memberRows = $state<Row[]>([]);
	let communes = $state<Row[]>([]);
	let neighborhoods = $state<Row[]>([]);
	let message = $state<string | null>(null);
	let info = $state<string | null>(null);
	let busy = $state(false);
	let cancelOpen = $state(false);
	let reason = $state('');
	let onlineShareToken = $state<string | null>(null);

	onMount(() => {
		const org = organizations.activeId;
		const onError = (error: Error) => (message = messageOf(error));
		const stops = [
			sync.watch<Row>(
				LOCAL_QUERIES.payment,
				[org, id],
				(rows) => {
					payment = rows[0] ? toPayment(rows[0]) : null;
					loaded = true;
				},
				onError
			),
			sync.watch<Row>(LOCAL_QUERIES.paymentReceipt, [org, id], (rows) => (receipt = rows[0] ? toReceipt(rows[0]) : null), onError),
			sync.watch<Row>(LOCAL_QUERIES.paymentDraft, [org, id], (rows) => (draft = rows[0] ? toDraft(rows[0]) : null), onError),
			sync.watch<Row>(LOCAL_QUERIES.organization, [org], (rows) => (orgRow = rows[0] ?? null), onError),
			sync.watch<Row>(LOCAL_QUERIES.allMembers, [org], (rows) => (memberRows = rows), onError),
			sync.watch<Row>(GEOGRAPHY_QUERIES.communes, [], (rows) => (communes = rows)),
			sync.watch<Row>(GEOGRAPHY_QUERIES.neighborhoods, [], (rows) => (neighborhoods = rows))
		];
		return () => stops.forEach((stop) => stop());
	});

	// Bail, locataire, unité, échéances et caution, dès que l'encaissement est lu.
	$effect(() => {
		const org = organizations.activeId;
		const leaseId = payment?.leaseId;
		if (!leaseId) return;
		const stops = [
			sync.watch<Row>(LOCAL_QUERIES.lease, [org, leaseId], (rows) => (leaseRow = rows[0] ?? null)),
			sync.watch<Row>(LOCAL_QUERIES.leaseDues, [org, leaseId], (rows) => (dueRows = rows)),
			sync.watch<Row>(LOCAL_QUERIES.leaseDeposits, [org, leaseId], (rows) => (accountRows = rows)),
			sync.watch<Row>(LOCAL_QUERIES.leaseMovements, [org, leaseId], (rows) => (movementRows = rows))
		];
		return () => stops.forEach((stop) => stop());
	});
	$effect(() => {
		const org = organizations.activeId;
		const tenantId = leaseRow ? String(leaseRow.tenant_id) : null;
		const unitId = leaseRow ? String(leaseRow.unit_id) : null;
		if (!tenantId || !unitId) return;
		const stops = [
			sync.watch<Row>(LOCAL_QUERIES.tenant, [org, tenantId], (rows) => (tenantRow = rows[0] ?? null)),
			sync.watch<Row>(LOCAL_QUERIES.unit, [org, unitId], (rows) => (unitRow = rows[0] ?? null))
		];
		return () => stops.forEach((stop) => stop());
	});
	$effect(() => {
		const org = organizations.activeId;
		const propertyId = unitRow ? String(unitRow.property_id) : null;
		if (!propertyId) return;
		return sync.watch<Row>(LOCAL_QUERIES.property, [org, propertyId], (rows) => (propertyRow = rows[0] ?? null));
	});

	const tenant = $derived(tenantRow ? toTenant(tenantRow) : null);
	const organization = $derived.by<ReceiptOrganizationSnapshot | null>(() => {
		if (!orgRow) return null;
		const o = toOrganizationView(orgRow, '');
		return {
			name: o.tradeName ?? o.legalName,
			address: o.address,
			commune: o.commune,
			poBox: o.poBox,
			phone: o.phone ? formatPhone(o.phone) : null,
			rccm: o.rccm,
			ifu: o.ifu,
			logoId: null
		};
	});
	const collectedBy = $derived(
		(payment?.recordedBy && String(memberRows.find((m) => m.user_id === payment!.recordedBy)?.display_name ?? '')) || auth.user?.name || ''
	);
	const unitLabel = $derived(propertyRow && unitRow ? `${propertyRow.name} — ${unitRow.label}` : String(unitRow?.label ?? ''));
	const unitAddress = $derived.by(() => {
		if (!propertyRow) return null;
		const parts = [
			propertyRow.address_hint,
			neighborhoods.find((n) => n.id === propertyRow!.neighborhood_id)?.name,
			communes.find((c) => c.id === propertyRow!.commune_id)?.name
		].filter((v): v is string => typeof v === 'string' && !!v);
		return parts.length ? parts.join(', ') : null;
	});
	const dues = $derived<DueForScreen[]>(dueRows.map((r) => ({ ...toRentDue(r, today), waived: r.status === 'waived' })));
	const deposit = $derived.by(() => {
		if (!payment?.depositAccountId) return null;
		const row = accountRows.find((a) => a.id === payment!.depositAccountId);
		if (!row) return null;
		const view = toDepositAccount(row, movementRows.map(toMovement), Number(leaseRow?.rent ?? 0));
		return { type: view.type, holder: view.holder, remainingDue: view.balances.remainingDue };
	});
	/** Reçu provisoire calculé sur l'appareil, tant que le serveur n'a pas émis le sien. */
	const local = $derived(
		payment && organization && tenant && !receipt?.snapshot
			? localSnapshot({
					organization,
					tenantName: tenant.fullName,
					unit: { label: unitLabel, address: unitAddress },
					payment,
					dues,
					deposit,
					collectedBy,
					today
				})
			: null
	);
	const doc = $derived(receiptToShow(receipt, draft, local, origin));
	const shareToken = $derived(draft?.shareToken ?? onlineShareToken);
	const link = $derived(shareToken ? shareUrl(origin, shareToken) : null);
	const awaiting = $derived(payment?.status === 'to_validate' || payment?.status === 'to_reconcile');
	const canValidate = $derived(can(role, 'payment.validate') && awaiting);
	const canCancel = $derived(
		can(role, 'payment.cancel') && !!payment && ['to_validate', 'to_reconcile', 'confirmed'].includes(payment.status)
	);
	const canShare = $derived(can(role, 'receipt.share'));

	async function online(fn: () => Promise<void>, done?: string) {
		message = null;
		info = null;
		busy = true;
		try {
			await fn();
			if (done) info = done;
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}

	async function share() {
		if (!doc || !link) return;
		const text = shareText(doc, organization?.name ?? '', link);
		if (navigator.share) {
			await navigator.share({ title: `${doc.title} ${doc.number}`, text, url: link }).catch(() => undefined);
		} else {
			await navigator.clipboard?.writeText(link);
			info = t.linkCopied;
		}
	}

	async function copy() {
		if (!link) return;
		await navigator.clipboard?.writeText(link);
		info = t.linkCopied;
	}

	const newLink = () =>
		online(async () => {
			const r = await organizations.call<{ token: string }>('POST', `/receipts/${receipt!.id}/share-token`);
			onlineShareToken = r.token;
		});

	const revoke = () =>
		online(async () => {
			await organizations.call('POST', `/receipts/${receipt!.id}/share-token/revoke`);
			onlineShareToken = null;
		}, t.linksRevoked);

	const pdf = (format: ReceiptFormat) =>
		online(async () => {
			const r = await organizations.call<{ url: string }>('GET', `/receipts/${receipt!.id}/pdf?format=${format}`);
			window.open(r.url, '_blank', 'noopener');
		});

	const validate = () =>
		online(async () => {
			const [r] = await organizations.call<PaymentValidationResult[]>('POST', '/payments/validate', { paymentIds: [id] });
			if (r?.status !== 'confirmed') throw new Error(r?.message ?? t.notFound);
		}, t.validated);

	async function cancel(event: SubmitEvent) {
		event.preventDefault();
		const parsed = cancelPaymentSchema.safeParse({ reason });
		if (!parsed.success) return void (message = parsed.error.issues[0]!.message);
		await online(async () => {
			await organizations.call('POST', `/payments/${id}/cancel`, parsed.data);
			cancelOpen = false;
			reason = '';
		}, t.cancelled);
	}

	const side = $derived(!device.isPhone);
	const action = 'w-full justify-start';
</script>

<PageHeader title={t.receiptOf} back="app/encaissements" backLabel={t.back} />

<main class="page pt-3 pb-10" data-testid="fiche-encaissement">
	{#if loaded && !payment}
		<FormAlert message={t.notFound} />
	{:else if payment}
		<FormAlert {message} />
		<FormAlert message={info} tone="info" />
		<div class={cn('gap-6', side ? 'grid grid-cols-[minmax(0,3fr)_minmax(15rem,2fr)] items-start' : 'space-y-4')}>
			<div class="space-y-3">
				<div class="flex flex-wrap items-center gap-2">
					<Badge variant={statusTone(payment.status)} data-testid="statut-encaissement">{t.status[payment.status]}</Badge>
					<span class="text-base tabular-nums">{formatFcfa(payment.amount)} · {t.methods[payment.method]}</span>
				</div>
				{#if payment.status === 'pending_upload'}<FormAlert
						message={t.pendingUploadNote}
						tone="info"
					/>{:else if receipt && !receipt.number && payment.status !== 'cancelled'}<FormAlert
						message={t.provisionalNote}
						tone="info"
					/>{/if}
				{#if payment.cancellationReason}<p class="text-base text-destructive">{t.cancellation(payment.cancellationReason)}</p>{/if}
				{#if doc}<ReceiptDocumentView document={doc} />{/if}
			</div>

			<aside class={cn('space-y-2', side && device.isDesktop && 'sticky top-20')} aria-label={t.receipt}>
				{#if canShare}
					{#if link}
						<Button class={action} onclick={share} data-testid="partager"><Share2 class="size-5" aria-hidden="true" />{t.share}</Button>
						<Button
							class={action}
							variant="outline"
							href={whatsappLink(tenant?.phone ?? null, shareText(doc ?? { title: '', number: '' }, organization?.name ?? '', link))}
							target="_blank"
							rel="noopener"
							data-testid="partager-whatsapp"><MessageCircle class="size-5" aria-hidden="true" />{t.shareWhatsapp}</Button
						>
						<Button class={action} variant="outline" onclick={copy}><Copy class="size-5" aria-hidden="true" />{t.copyLink}</Button>
						<p class="text-sm break-all text-muted-foreground" data-testid="lien-recu">{link}</p>
					{:else if receipt}
						<p class="text-sm text-muted-foreground">{t.shareNeedsDevice}</p>
						<Button class={action} variant="outline" onclick={newLink} disabled={busy || !sync.online}
							><Link2 class="size-5" aria-hidden="true" />{t.newLink}</Button
						>
					{/if}
				{/if}
				<Button class={action} variant="outline" onclick={() => window.print()} data-testid="imprimer"
					><Printer class="size-5" aria-hidden="true" />{t.print}</Button
				>
				{#if receipt?.number}
					<div class="grid grid-cols-2 gap-2">
						<Button variant="outline" onclick={() => pdf('a6')} disabled={busy || !sync.online}
							><FileDown class="size-5" aria-hidden="true" />{t.pdfA6}</Button
						>
						<Button variant="outline" onclick={() => pdf('ticket')} disabled={busy || !sync.online}
							><FileDown class="size-5" aria-hidden="true" />{t.pdfTicket}</Button
						>
					</div>
				{/if}
				{#if canValidate}
					<Button class={action} onclick={validate} disabled={busy || !sync.online} data-testid="valider"
						><CircleCheck class="size-5" aria-hidden="true" />{payment.status === 'to_validate' ? t.validate : t.reconcile}</Button
					>
				{/if}
				{#if canShare && receipt && sync.online}
					<Button class={action} variant="ghost" onclick={revoke} disabled={busy}>{t.revokeLinks}</Button>
				{/if}
				{#if canCancel}
					<Button class={action} variant="destructive" onclick={() => (cancelOpen = true)} disabled={!sync.online} data-testid="annuler"
						><Ban class="size-5" aria-hidden="true" />{t.cancel}</Button
					>
				{/if}
				{#if !sync.online && (canValidate || canCancel || receipt?.number)}<p class="text-sm text-muted-foreground">{t.offlineOnly}</p>{/if}
			</aside>
		</div>

		<Sheet bind:open={cancelOpen} labelledby="titre-annulation">
			<form class="space-y-4" onsubmit={cancel}>
				<h2 id="titre-annulation" class="text-lg font-semibold">{t.cancelTitle}</h2>
				<p class="text-base text-muted-foreground">{t.cancelHint}</p>
				<div class="space-y-1">
					<label for="motif" class="text-base font-medium">{t.cancelReason}</label>
					<Input id="motif" bind:value={reason} data-testid="motif-annulation" />
				</div>
				<Button type="submit" variant="destructive" class="w-full" disabled={busy} data-testid="confirmer-annulation"
					>{t.confirmCancel}</Button
				>
			</form>
		</Sheet>
	{/if}
</main>
