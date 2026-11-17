<script lang="ts">
	/**
	 * Impayés (lot 10, docs/UX.md §4), lus sur l'appareil, calculés par la même fonction que l'API. Téléphone : une carte
	 * par locataire, deux boutons (Relancer, Encaisser) ; tablette : tableau ; ordinateur : tableau, sélection multiple et
	 * « Relancer la sélection » (relances en série). Une échéance couverte par un encaissement à valider n'est ni proposée
	 * ni relancée. `round` : « Ma tournée » de l'agent de terrain (échéances du jour comprises, visite ou appel).
	 */
	import { onMount } from 'svelte';
	import { Banknote, MessageCircle, NotebookPen, Phone } from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import { ARREARS_BUCKETS, canRemind, type ArrearsBucket, type ArrearsGroup } from '@ziga/shared/collections';
	import { formatDate, toIsoDate } from '@ziga/shared/dates';
	import { formatFcfa } from '@ziga/shared/money';
	import { can } from '@ziga/shared/permissions';
	import { formatPhone } from '@ziga/shared/phone';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import FeatureGate from '#lib/components/FeatureGate.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { localArrears, reminderSettingsOf } from '#lib/collections/views.ts';
	import { device } from '#lib/device.svelte.ts';
	import { features } from '#lib/features/features.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';
	import ReminderFlow from './ReminderFlow.svelte';
	import VisitNote from './VisitNote.svelte';

	type Row = Record<string, unknown>;
	let { round = false }: { round?: boolean } = $props();
	const t = fr.arrears;

	let dues = $state<Row[]>([]);
	let claims = $state<Row[]>([]);
	let tenants = $state<Row[]>([]);
	let awaiting = $state<Row[]>([]);
	let reminders = $state<Row[]>([]);
	let units = $state<Row[]>([]);
	let owners = $state<Row[]>([]);
	let agents = $state<Row[]>([]);
	let neighborhoods = $state<Row[]>([]);
	let settingsRow = $state<Row | null>(null);
	let orgRow = $state<Row | null>(null);
	let loaded = $state(false);
	let message = $state<string | null>(null);
	let info = $state<string | null>(null);

	let neighborhoodId = $state('');
	let ownerId = $state('');
	let agentId = $state('');
	let bucket = $state<ArrearsBucket | ''>('');
	let selected = $state<string[]>([]);
	let queue = $state<ArrearsGroup[]>([]);
	let flowOpen = $state(false);
	let visitFor = $state<ArrearsGroup | null>(null);
	let visitOpen = $state(false);

	const role = $derived(organizations.active?.role);
	const canSend = $derived(can(role, 'reminder.send') && features.isEnabled('collections.reminders_whatsapp_link'));
	const canVisit = $derived(can(role, 'reminder.record_visit'));
	const canCollect = $derived(can(role, 'payment.record_cash'));
	const multi = $derived(device.isDesktop && canSend && !round);

	onMount(() => {
		const org = organizations.activeId;
		const onError = (error: Error) => (message = messageOf(error));
		const stops = [
			sync.watch<Row>(LOCAL_QUERIES.arrearsDues, [org], (r) => ((dues = r), (loaded = true)), onError),
			sync.watch<Row>(LOCAL_QUERIES.expenseClaims, [org], (r) => (claims = r), onError),
			sync.watch<Row>(LOCAL_QUERIES.tenants, [org], (r) => (tenants = r), onError),
			sync.watch<Row>(LOCAL_QUERIES.awaitingPayments, [org], (r) => (awaiting = r), onError),
			sync.watch<Row>(LOCAL_QUERIES.reminders, [org], (r) => (reminders = r), onError),
			sync.watch<Row>(LOCAL_QUERIES.unitContexts, [org], (r) => (units = r), onError),
			sync.watch<Row>(LOCAL_QUERIES.owners, [org], (r) => (owners = r), onError),
			sync.watch<Row>(LOCAL_QUERIES.fieldAgents, [org], (r) => (agents = r), onError),
			sync.watch<Row>(LOCAL_QUERIES.reminderSettings, [org], (r) => (settingsRow = r[0] ?? null), onError),
			sync.watch<Row>(LOCAL_QUERIES.organization, [org], (r) => (orgRow = r[0] ?? null), onError)
		];
		return () => stops.forEach((s) => s());
	});
	onMount(() => sync.watch<Row>('SELECT * FROM neighborhoods ORDER BY name COLLATE NOCASE', [], (r) => (neighborhoods = r)));

	const today = toIsoDate();
	const settings = $derived(reminderSettingsOf(settingsRow));
	const org = $derived({
		name: String(orgRow?.trade_name || orgRow?.legal_name || organizations.active?.name || ''),
		phone: (orgRow?.phone as string) ?? null
	});
	const groups = $derived(
		localArrears(
			{ dues, claims, tenants, awaiting, reminders, units, settings: settingsRow },
			today,
			round ? {} : { neighborhoodId: neighborhoodId || null, ownerId: ownerId || null, agentId: agentId || null, bucket: bucket || null },
			round
		)
	);
	const unitLabel = $derived(new Map(units.map((u) => [String(u.id), `${u.property_name} · ${u.label}`])));
	const usedNeighborhoods = $derived(new Set(units.map((u) => String(u.neighborhood_id ?? ''))));
	const leaseOf = (g: ArrearsGroup) => g.items[0]?.leaseId ?? '';
	const unitOf = (g: ArrearsGroup) => unitLabel.get(g.items[0]?.unitId ?? '') ?? '';

	function remindOne(g: ArrearsGroup) {
		queue = [g];
		flowOpen = true;
	}
	function remindSelection() {
		queue = groups.filter((g) => selected.includes(g.tenantId) && canRemind(g));
		if (queue.length) flowOpen = true;
	}
	function done(n: number) {
		info = n ? fr.reminders.seriesDone(n) : null;
		selected = [];
	}
	const selectable = $derived(groups.filter((g) => canRemind(g)).map((g) => g.tenantId));
	const allSelected = $derived(selectable.length > 0 && selectable.every((id) => selected.includes(id)));
	const select = 'min-h-11 w-full rounded-lg border bg-background px-3 text-base sm:w-auto';
</script>

<div class="space-y-4" data-testid={round ? 'tournee' : 'impayes'}>
	<FormAlert {message} />
	<FormAlert message={info} tone="info" />

	{#if !round}
		<div class="flex flex-wrap gap-2" role="group" aria-label={t.filtersLabel}>
			<label class="sr-only" for="filtre-tranche">{t.bucket}</label>
			<select id="filtre-tranche" class={select} bind:value={bucket} data-testid="filtre-tranche">
				<option value="">{t.buckets.all}</option>
				{#each ARREARS_BUCKETS as b (b)}<option value={b}>{t.buckets[b]}</option>{/each}
			</select>
			<label class="sr-only" for="filtre-quartier">{t.neighborhood}</label>
			<select id="filtre-quartier" class={select} bind:value={neighborhoodId}>
				<option value="">{t.allNeighborhoods}</option>
				{#each neighborhoods.filter((n) => usedNeighborhoods.has(String(n.id))) as n (n.id)}<option value={n.id}>{n.name}</option>{/each}
			</select>
			<label class="sr-only" for="filtre-proprietaire">{t.owner}</label>
			<select id="filtre-proprietaire" class={select} bind:value={ownerId}>
				<option value="">{t.allOwners}</option>
				{#each owners as o (o.id)}<option value={o.id}>{o.name}</option>{/each}
			</select>
			{#if agents.length}
				<label class="sr-only" for="filtre-agent">{t.agent}</label>
				<select id="filtre-agent" class={select} bind:value={agentId}>
					<option value="">{t.allAgents}</option>
					{#each agents as a (a.user_id)}<option value={a.user_id}>{a.display_name}</option>{/each}
				</select>
			{/if}
		</div>
	{/if}

	{#if multi && groups.length}
		<div class="flex flex-wrap items-center gap-3">
			<label class="flex min-h-11 items-center gap-2 text-base">
				<input
					type="checkbox"
					class="size-5"
					checked={allSelected}
					onchange={() => (selected = allSelected ? [] : [...selectable])}
					data-testid="tout-selectionner"
				/>{t.selectAll}
			</label>
			<Button onclick={remindSelection} disabled={!selected.length} data-testid="relancer-selection"
				><MessageCircle class="size-5" aria-hidden="true" />{t.remindSelection(selected.length)}</Button
			>
		</div>
	{/if}

	{#if loaded && !groups.length}
		<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground">
			{round ? fr.dashboard.roundEmpty : neighborhoodId || ownerId || agentId || bucket ? t.emptyFilter : t.empty}
		</p>
	{:else if !device.isPhone}
		<div class="relative overflow-x-auto rounded-xl border bg-card">
			<table class="w-full text-left text-base">
				<thead class="border-b text-muted-foreground">
					<tr>
						{#if multi}<th class="w-12 px-3 py-3"><span class="sr-only">{t.selectAll}</span></th>{/if}
						<th class="px-4 py-3 font-medium">{t.columns.tenant}</th>
						<th class="px-4 py-3 text-right font-medium">{t.columns.total}</th>
						<th class="px-4 py-3 font-medium">{t.columns.late}</th>
						{#if device.isDesktop}<th class="px-4 py-3 font-medium">{t.columns.last}</th>{/if}
						<th class="px-4 py-3 font-medium">{t.columns.actions}</th>
					</tr>
				</thead>
				<tbody class="divide-y">
					{#each groups as g (g.tenantId)}
						<tr data-testid="impaye" data-locataire={g.tenantName}>
							{#if multi}
								<td class="px-3 py-3">
									{#if canRemind(g)}<input
											type="checkbox"
											class="size-5"
											value={g.tenantId}
											bind:group={selected}
											aria-label={t.select(g.tenantName)}
										/>{/if}
								</td>
							{/if}
							<td class="px-4 py-3">
								<span class="font-medium break-words">{g.tenantName}</span>
								<span class="block text-sm text-muted-foreground">{unitOf(g)} · {t.periods(g.items.length)}</span>
								{#if g.awaitingValidation}<Badge variant="secondary">{t.awaiting}</Badge>{/if}
							</td>
							<td class="px-4 py-3 text-right whitespace-nowrap tabular-nums">{formatFcfa(g.total)}</td>
							<td class="px-4 py-3">
								{t.daysLate(g.daysLate)}
								{#if g.suggestion}<span class="block text-sm text-muted-foreground">{t.suggested(g.suggestion.level)}</span>{/if}
							</td>
							{#if device.isDesktop}
								<td class="px-4 py-3 text-sm">
									{g.lastReminder ? `${fr.reminders.channels[g.lastReminder.channel]} · ${formatDate(g.lastReminder.sentAt)}` : t.never}
								</td>
							{/if}
							<td class="px-4 py-3">
								<div class="flex flex-wrap gap-2">
									{#if canSend && !round}
										<Button onclick={() => remindOne(g)} disabled={!canRemind(g)} data-testid="relancer">{t.remind}</Button>
									{/if}
									{#if canCollect}
										<Button variant="outline" href={`${resolve('/app/encaisser')}?bail=${leaseOf(g)}`}>{t.collect}</Button>
									{/if}
									{#if canVisit && (round || !canSend)}
										<Button variant="outline" onclick={() => ((visitFor = g), (visitOpen = true))} data-testid="noter-visite"
											>{t.visit}</Button
										>
									{/if}
									{#if g.phone && device.isDesktop}
										<Button variant="ghost" href={`tel:${g.phone}`}><Phone class="size-4" aria-hidden="true" />{t.call}</Button>
									{/if}
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<ul class="space-y-3">
			{#each groups as g (g.tenantId)}
				<li class="space-y-3 rounded-xl border bg-card p-4" data-testid="impaye" data-locataire={g.tenantName}>
					<div class="flex flex-wrap items-start justify-between gap-2">
						<div class="min-w-0">
							<p class="font-semibold break-words">{g.tenantName}</p>
							<p class="text-sm break-words text-muted-foreground">{unitOf(g)}</p>
							{#if g.phone}<p class="text-sm text-muted-foreground">{formatPhone(g.phone)}</p>{/if}
						</div>
						<p class="font-semibold tabular-nums">{formatFcfa(g.total)}</p>
					</div>
					<p class="text-base">
						{t.daysLate(g.daysLate)} · {t.periods(g.items.length)}
						{#if g.suggestion}<span class="block text-sm text-muted-foreground">{t.suggested(g.suggestion.level)}</span>{/if}
					</p>
					<p class="text-sm text-muted-foreground">
						{t.lastReminder} : {g.lastReminder
							? `${fr.reminders.channels[g.lastReminder.channel]} · ${formatDate(g.lastReminder.sentAt)}`
							: t.never}
					</p>
					{#if g.awaitingValidation}<p class="text-sm text-muted-foreground">{t.awaitingHint}</p>{/if}
					<div class="grid grid-cols-2 gap-2">
						{#if canSend && !round}
							<Button onclick={() => remindOne(g)} disabled={!canRemind(g)} data-testid="relancer"
								><MessageCircle class="size-5" aria-hidden="true" />{t.remind}</Button
							>
						{:else if canVisit}
							<Button variant="outline" onclick={() => ((visitFor = g), (visitOpen = true))} data-testid="noter-visite"
								><NotebookPen class="size-5" aria-hidden="true" />{t.visit}</Button
							>
						{/if}
						{#if canCollect}
							<Button variant="outline" href={`${resolve('/app/encaisser')}?bail=${leaseOf(g)}`}
								><Banknote class="size-5" aria-hidden="true" />{t.collect}</Button
							>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<FeatureGate key="collections.reminders_whatsapp_link">
	<ReminderFlow bind:open={flowOpen} {queue} {settings} {org} onDone={done} />
</FeatureGate>
<VisitNote bind:open={visitOpen} group={visitFor} onDone={() => (info = fr.reminders.recorded)} />
