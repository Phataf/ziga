<script lang="ts">
	/**
	 * Liste des encaissements (lot 09, docs/UX.md §4), lue sur l'appareil. Téléphone : cartes et filtres en pastilles ;
	 * tablette et ordinateur : tableau. `awaiting` : seulement les espèces « à valider » et le Mobile Money ou les
	 * virements « à rapprocher », avec la validation groupée (direction et gestion, en ligne : le serveur impute et
	 * numérote). Un refus n'arrête pas les autres validations.
	 */
	import { onMount } from 'svelte';
	import { CircleCheck } from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import { formatDate } from '@ziga/shared/dates';
	import { formatFcfa } from '@ziga/shared/money';
	import { can } from '@ziga/shared/permissions';
	import type { PaymentValidationResult } from '@ziga/shared/receipts';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { statusTone } from '#lib/payments/tones.ts';
	import { toPayment, type LocalPayment } from '#lib/payments/views.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';
	import { cn } from '#lib/utils.ts';

	type Row = Record<string, unknown>;
	type Filter = 'all' | 'awaiting' | 'confirmed' | 'cancelled';
	type Item = LocalPayment & { tenantName: string; unitLabel: string; receiptNumber: string | null };

	let { awaitingOnly = false }: { awaitingOnly?: boolean } = $props();
	const t = fr.payments;
	const canValidate = $derived(can(organizations.active?.role, 'payment.validate'));

	let items = $state<Item[]>([]);
	let loaded = $state(false);
	let chosen = $state<Filter>('all');
	const filter = $derived<Filter>(awaitingOnly ? 'awaiting' : chosen);
	let selected = $state<string[]>([]);
	let message = $state<string | null>(null);
	let info = $state<string | null>(null);
	let busy = $state(false);

	onMount(() =>
		sync.watch<Row>(
			LOCAL_QUERIES.paymentsList,
			[organizations.activeId],
			(rows) => {
				items = rows.map((r) => ({
					...toPayment(r),
					tenantName: String(r.tenant_name ?? ''),
					unitLabel: String(r.unit_label ?? ''),
					receiptNumber: (r.receipt_number ?? r.receipt_provisional ?? null) as string | null
				}));
				loaded = true;
			},
			(error) => (message = messageOf(error))
		)
	);

	const isAwaiting = (p: Item) => p.status === 'to_validate' || p.status === 'to_reconcile';
	const shown = $derived(
		items.filter((p) =>
			filter === 'all'
				? true
				: filter === 'awaiting'
					? isAwaiting(p)
					: filter === 'confirmed'
						? p.status === 'confirmed'
						: p.status === 'cancelled'
		)
	);
	const selectable = $derived(canValidate && shown.some(isAwaiting));
	const allSelected = $derived(selectable && shown.filter(isAwaiting).every((p) => selected.includes(p.id)));

	function toggleAll() {
		selected = allSelected ? [] : shown.filter(isAwaiting).map((p) => p.id);
	}

	async function validateSelection() {
		message = null;
		info = null;
		busy = true;
		try {
			const results = await organizations.call<PaymentValidationResult[]>('POST', '/payments/validate', { paymentIds: selected });
			const ok = results.filter((r) => r.status === 'confirmed').length;
			const refused = results.filter((r) => r.status === 'rejected');
			info = [ok ? t.validatedCount(ok) : '', refused.length ? t.rejectedCount(refused.length) : ''].filter(Boolean).join(' ');
			if (refused.length) message = refused.map((r) => r.message).join(' ');
			selected = refused.map((r) => r.paymentId);
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}

	const filters: [Filter, string][] = [
		['all', t.filters.all],
		['awaiting', t.filters.awaiting],
		['confirmed', t.filters.confirmed],
		['cancelled', t.filters.cancelled]
	];
</script>

<div class="space-y-4" data-testid={awaitingOnly ? 'a-valider' : 'liste-encaissements'}>
	<FormAlert {message} />
	<FormAlert message={info} tone="info" />
	{#if !awaitingOnly}
		<div class="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label={t.filtersLabel}>
			{#each filters as [value, label] (value)}
				<button
					type="button"
					class={cn(
						'min-h-11 shrink-0 rounded-full border-2 px-4 text-base font-medium',
						filter === value ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-accent'
					)}
					aria-pressed={filter === value}
					onclick={() => {
						chosen = value;
						selected = [];
					}}>{label}</button
				>
			{/each}
		</div>
	{/if}

	{#if selectable}
		<div class="flex flex-wrap items-center gap-3">
			<label class="flex min-h-11 items-center gap-2 text-base">
				<input type="checkbox" class="size-5" checked={allSelected} onchange={toggleAll} data-testid="tout-selectionner" />{t.selectAll}
			</label>
			<Button onclick={validateSelection} disabled={busy || !selected.length || !sync.online} data-testid="valider-selection"
				><CircleCheck class="size-5" aria-hidden="true" />{t.validateSelection(selected.length)}</Button
			>
			{#if !sync.online}<span class="text-sm text-muted-foreground">{t.offlineOnly}</span>{/if}
		</div>
	{/if}

	{#if loaded && !items.length}
		<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground">{awaitingOnly ? t.toValidateEmpty : t.empty}</p>
	{:else if loaded && !shown.length}
		<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground">{awaitingOnly ? t.toValidateEmpty : t.emptyFilter}</p>
	{:else if !device.isPhone}
		<div class="relative overflow-x-auto rounded-xl border bg-card">
			<table class="w-full text-left text-base">
				<thead class="border-b text-muted-foreground">
					<tr>
						{#if selectable}<th class="w-12 px-3 py-3"><span class="sr-only">{t.selectAll}</span></th>{/if}
						<th class="px-4 py-3 font-medium">{t.columns.date}</th>
						<th class="px-4 py-3 font-medium">{t.columns.tenant}</th>
						{#if device.isDesktop}<th class="px-4 py-3 font-medium">{t.columns.purpose}</th>{/if}
						<th class="px-4 py-3 font-medium">{t.columns.method}</th>
						<th class="px-4 py-3 text-right font-medium">{t.columns.amount}</th>
						<th class="px-4 py-3 font-medium">{t.columns.status}</th>
						{#if device.isDesktop}<th class="px-4 py-3 font-medium">{t.columns.receipt}</th>{/if}
					</tr>
				</thead>
				<tbody class="divide-y">
					{#each shown as p (p.id)}
						<tr data-testid="encaissement" data-statut={p.status}>
							{#if selectable}
								<td class="px-3 py-3">
									{#if isAwaiting(p)}
										<input type="checkbox" class="size-5" value={p.id} bind:group={selected} aria-label={t.select(p.tenantName)} />
									{/if}
								</td>
							{/if}
							<td class="px-4 py-3 whitespace-nowrap tabular-nums">{p.paidOn ? formatDate(p.paidOn) : ''}</td>
							<td class="px-4 py-3">
								<a class="font-medium underline-offset-2 hover:underline" href={resolve('/app/encaissements/[id]', { id: p.id })}
									>{p.tenantName}</a
								>
								<span class="block text-sm text-muted-foreground">{p.unitLabel}</span>
							</td>
							{#if device.isDesktop}<td class="px-4 py-3">{t.purposes[p.purpose]}</td>{/if}
							<td class="px-4 py-3">{t.methods[p.method]}</td>
							<td class="px-4 py-3 text-right whitespace-nowrap tabular-nums">{formatFcfa(p.amount)}</td>
							<td class="px-4 py-3"><Badge variant={statusTone(p.status)}>{t.status[p.status]}</Badge></td>
							{#if device.isDesktop}<td class="px-4 py-3 whitespace-nowrap tabular-nums">{p.receiptNumber ?? ''}</td>{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<ul class="space-y-3">
			{#each shown as p (p.id)}
				<li class="flex items-stretch gap-2" data-testid="encaissement" data-statut={p.status}>
					{#if selectable && isAwaiting(p)}
						<label class="flex min-w-11 items-center justify-center">
							<input type="checkbox" class="size-5" value={p.id} bind:group={selected} aria-label={t.select(p.tenantName)} />
						</label>
					{/if}
					<a
						class="block min-w-0 flex-1 space-y-1 rounded-xl border bg-card p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
						href={resolve('/app/encaissements/[id]', { id: p.id })}
					>
						<span class="flex flex-wrap items-center justify-between gap-2">
							<span class="font-semibold break-words">{p.tenantName}</span>
							<span class="font-semibold tabular-nums">{formatFcfa(p.amount)}</span>
						</span>
						<span class="block text-sm text-muted-foreground"
							>{p.paidOn ? formatDate(p.paidOn) : ''} · {t.purposes[p.purpose]} · {t.methods[p.method]}</span
						>
						<Badge variant={statusTone(p.status)}>{t.status[p.status]}</Badge>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</div>
