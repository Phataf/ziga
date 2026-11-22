<script lang="ts">
	/**
	 * Une sortie (lot 10 bis, étape 4), lue sur l'appareil : congé, état des lieux d'entrée et de sortie, comparaison,
	 * décompte de caution et restitution. Commencer l'état des lieux s'écrit sur l'appareil (hors ligne compris) ; le
	 * congé et le décompte se font en ligne. L'agent de terrain n'y voit que l'état des lieux de ses unités.
	 */
	import { onMount } from 'svelte';
	import { ArrowLeftRight, ClipboardCheck, FileText, LogOut, Wallet } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { formatDate, toIsoDate } from '@ziga/shared/dates';
	import { newId } from '@ziga/shared/ids';
	import type { LeaseView, TenantView } from '@ziga/shared/leases';
	import { formatFcfa } from '@ziga/shared/money';
	import { can } from '@ziga/shared/permissions';
	import type { UnitView } from '@ziga/shared/properties';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import NoticeForm from '#lib/components/exit/NoticeForm.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import {
		exitStage,
		toInspection,
		toNotice,
		toSettlement,
		type LocalInspection,
		type LocalNotice,
		type LocalSettlement
	} from '#lib/exit/views.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { toLease, toTenant } from '#lib/leases/views.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { toUnit } from '#lib/properties/views.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';
	import { createInspection } from '#lib/sync/writes.ts';

	type Row = Record<string, unknown>;
	const t = fr.exit;
	const today = toIsoDate();
	const id = $derived(page.params.id ?? '');
	const role = $derived(organizations.active?.role);

	let lease = $state<LeaseView | null>(null);
	let unit = $state<UnitView | null>(null);
	let tenant = $state<TenantView | null>(null);
	let notices = $state<LocalNotice[]>([]);
	let inspections = $state<LocalInspection[]>([]);
	let settlements = $state<LocalSettlement[]>([]);
	let loaded = $state(false);
	let message = $state<string | null>(null);
	let noticeOpen = $state(false);

	onMount(() => {
		const org = organizations.activeId;
		const onError = (error: Error) => (message = messageOf(error));
		const stops = [
			sync.watch<Row>(LOCAL_QUERIES.lease, [org, id], (r) => ((lease = r[0] ? toLease(r[0], false) : null), (loaded = true)), onError),
			sync.watch<Row>(LOCAL_QUERIES.leaseNotices, [org, id], (r) => (notices = r.map(toNotice)), onError),
			sync.watch<Row>(LOCAL_QUERIES.leaseInspections, [org, id], (r) => (inspections = r.map(toInspection)), onError)
		];
		if (can(role, 'deposit.read'))
			stops.push(sync.watch<Row>(LOCAL_QUERIES.leaseSettlements, [org, id], (r) => (settlements = r.map(toSettlement)), onError));
		return () => stops.forEach((s) => s());
	});

	// Unité et locataire : un abonnement par identifiant, jamais renouvelé à chaque nouvelle version du bail (le bail
	// change souvent pendant une sortie : congé, fin, échéances).
	const unitId = $derived(lease?.unitId ?? null);
	const tenantId = $derived(lease?.tenantId ?? null);
	$effect(() => {
		const org = organizations.activeId;
		if (!unitId) return;
		return sync.watch<Row>(LOCAL_QUERIES.unit, [org, unitId], (r) => (unit = r[0] ? toUnit(r[0]) : null));
	});
	$effect(() => {
		const org = organizations.activeId;
		if (!tenantId) return;
		return sync.watch<Row>(LOCAL_QUERIES.tenant, [org, tenantId], (r) => (tenant = r[0] ? toTenant(r[0]) : null));
	});

	const notice = $derived(notices.find((n) => n.status === 'recorded') ?? null);
	const entry = $derived(inspections.find((i) => i.type === 'entry') ?? null);
	const exitInsp = $derived(inspections.find((i) => i.type === 'exit') ?? null);
	const settlement = $derived(settlements.at(-1) ?? null);
	const stage = $derived(exitStage({ exitInspection: exitInsp, settlement }));
	const canInspect = $derived(can(role, 'inspection.create'));

	async function start(type: 'entry' | 'exit') {
		message = null;
		if (!lease) return;
		const inspectionId = newId();
		try {
			await createInspection(sync.db ?? (await sync.start()), organizations.activeId!, {
				id: inspectionId,
				leaseId: lease.id,
				type,
				inspectedOn: today,
				furnished: false
			});
			await goto(resolve('/app/sorties/[id]/etat-des-lieux/[inspectionId]', { id: lease.id, inspectionId }));
		} catch (error) {
			message = messageOf(error);
		}
	}

	const inspectionTone = (s: string) => (s === 'signed_both' ? 'success' : s === 'disputed' ? 'danger' : 'info');
	const inspectionLabel = (i: LocalInspection) =>
		i.status === 'signed_both' ? t.inspection.signed : i.status === 'disputed' ? t.inspection.disputed : t.stages.inspection;
</script>

<PageHeader
	title={tenant ? t.hub.title(tenant.fullName) : t.title}
	subtitle={unit ? `${unit.label}${lease?.exitOn ? ` · ${t.list.exitOn(formatDate(lease.exitOn))}` : ''}` : undefined}
	back="app/sorties"
	backLabel={t.back}
/>

<main class="page space-y-4 pt-3 pb-10" data-testid="sortie-locataire">
	<FormAlert {message} />
	{#if loaded && !lease}
		<FormAlert message={t.notFound} />
	{:else if lease}
		<p>
			<Badge variant={stage === 'closed' ? 'success' : stage === 'disputed' ? 'danger' : 'info'} data-testid="etape-sortie"
				>{t.stages[stage]}</Badge
			>
		</p>
		<div class="grid gap-4 lg:grid-cols-2">
			<section class="space-y-2 rounded-xl border bg-card p-4" aria-labelledby="titre-conge" data-testid="sortie-conge">
				<h2 id="titre-conge" class="flex items-center gap-2 text-lg font-semibold">
					<LogOut class="size-5" aria-hidden="true" />{t.hub.steps.notice}
				</h2>
				{#if notice}
					<p class="text-base break-words">
						{t.notice.summary(t.notice.origins[notice.origin]!, formatDate(notice.notifiedOn), formatDate(notice.plannedExitOn))}
					</p>
					{#if notice.noticeMonths !== null && notice.noticeEndsOn}<p class="text-base">
							{t.notice.preview(notice.noticeMonths, formatDate(notice.noticeEndsOn))}
						</p>{/if}
					{#if notice.rentEndsOn}<p class="text-base">{t.notice.rentUntil(formatDate(notice.rentEndsOn))}</p>{/if}
					{#if notice.indemnity}<p class="text-base">{t.notice.indemnity(formatFcfa(notice.indemnity))}</p>{/if}
				{:else}
					<p class="text-base text-muted-foreground">{t.hub.noNotice}</p>
					{#if can(role, 'lease.notice') && lease.status === 'active'}
						<Button onclick={() => (noticeOpen = true)} disabled={!sync.online} data-testid="preavis">{t.notice.action}</Button>
					{/if}
				{/if}
				{#if lease.status === 'ended'}<p class="text-base font-medium">{t.hub.ended}</p>{/if}
			</section>

			<section class="space-y-3 rounded-xl border bg-card p-4" aria-labelledby="titre-edl" data-testid="sortie-etats-des-lieux">
				<h2 id="titre-edl" class="flex items-center gap-2 text-lg font-semibold">
					<ClipboardCheck class="size-5" aria-hidden="true" />{t.hub.steps.inspection}
				</h2>
				{#each [entry, exitInsp] as i, k (k)}
					{#if i}
						<div class="flex flex-wrap items-center justify-between gap-2">
							<span class="min-w-0">
								<span class="block font-medium">{i.type === 'entry' ? t.hub.entry : t.hub.exit} · {formatDate(i.inspectedOn)}</span>
								<Badge variant={inspectionTone(i.status)}>{inspectionLabel(i)}</Badge>
							</span>
							<Button
								variant={i.status === 'draft' ? 'default' : 'outline'}
								href={resolve('/app/sorties/[id]/etat-des-lieux/[inspectionId]', { id: lease.id, inspectionId: i.id })}
								data-testid={i.type === 'exit' ? 'ouvrir-edl-sortie' : 'ouvrir-edl-entree'}
								>{i.status === 'draft' && canInspect ? t.hub.resumeInspection : t.hub.viewInspection}</Button
							>
						</div>
					{/if}
				{/each}
				{#if !exitInsp && canInspect && (lease.status === 'notice' || lease.status === 'ended')}
					<Button class="w-full" onclick={() => start('exit')} data-testid="commencer-edl">{t.hub.startInspection}</Button>
				{/if}
				{#if !entry && canInspect && (lease.status === 'signed' || lease.status === 'active')}
					<Button variant="outline" class="w-full" onclick={() => start('entry')} data-testid="commencer-edl-entree"
						>{t.hub.startEntry}</Button
					>
				{/if}
				{#if exitInsp}
					<Button variant="outline" class="w-full" href={resolve('/app/sorties/[id]/comparaison', { id: lease.id })} data-testid="comparer"
						><ArrowLeftRight class="size-5" aria-hidden="true" />{t.hub.compare}</Button
					>
				{/if}
			</section>

			<section class="space-y-2 rounded-xl border bg-card p-4 lg:col-span-2" aria-labelledby="titre-decompte" data-testid="sortie-decompte">
				<h2 id="titre-decompte" class="flex items-center gap-2 text-lg font-semibold">
					<Wallet class="size-5" aria-hidden="true" />{t.hub.steps.settlement}
				</h2>
				{#if !can(role, 'deposit.read')}
					<p class="text-base text-muted-foreground">{t.hub.fieldAgent}</p>
				{:else}
					{#if settlement}
						<dl class="grid grid-cols-1 gap-2 sm:grid-cols-3">
							<div class="rounded-lg bg-muted p-3">
								<dt class="text-sm text-muted-foreground">{t.settlement.received}</dt>
								<dd class="text-lg font-semibold tabular-nums">{formatFcfa(settlement.received)}</dd>
							</div>
							<div class="rounded-lg bg-muted p-3">
								<dt class="text-sm text-muted-foreground">{t.settlement.deductions}</dt>
								<dd class="text-lg font-semibold tabular-nums">{formatFcfa(settlement.deductions)}</dd>
							</div>
							<div class="rounded-lg bg-muted p-3">
								<dt class="text-sm text-muted-foreground">{settlement.claim > 0 ? t.settlement.claim : t.settlement.refund}</dt>
								<dd class="text-lg font-semibold tabular-nums" data-testid="resume-restitution">
									{formatFcfa(settlement.claim > 0 ? settlement.claim : settlement.refund)}
								</dd>
							</div>
						</dl>
						{#if settlement.refundAlert && settlement.status !== 'closed'}<Badge variant="danger"
								>{t.refundAlert[settlement.refundAlert]}</Badge
							>{/if}
					{/if}
					<Button href={resolve('/app/sorties/[id]/decompte', { id: lease.id })} data-testid="ouvrir-decompte"
						><FileText class="size-5" aria-hidden="true" />{t.hub.settlement}</Button
					>
				{/if}
			</section>
		</div>
		<NoticeForm bind:open={noticeOpen} {lease} />
	{/if}
</main>
