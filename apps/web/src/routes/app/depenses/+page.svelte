<script lang="ts">
	/**
	 * Dépenses (lot 10, CLAUDE.md règle 16) : une dépense est un seul enregistrement — qui a payé, qui la supporte,
	 * comment elle est récupérée. Liste lue sur l'appareil (cartes sur téléphone, tableau ailleurs) ; saisie hors ligne
	 * comprise (ajout seul) ; annulation motivée par le directeur, en ligne. La commission n'est pas une dépense.
	 */
	import { onMount } from 'svelte';
	import { Plus } from '@lucide/svelte';
	import { formatDate, toIsoDate } from '@ziga/shared/dates';
	import {
		allowedExpenseCombinations,
		cancelExpenseSchema,
		EXPENSE_CATEGORIES,
		EXPENSE_CATEGORY_LABELS,
		expenseNeedsLease,
		expenseSchema
	} from '@ziga/shared/expenses';
	import { newId } from '@ziga/shared/ids';
	import { formatFcfa, parseFcfa } from '@ziga/shared/money';
	import { can } from '@ziga/shared/permissions';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import Sheet from '#lib/components/ui/sheet/Sheet.svelte';
	import { messageOf } from '#lib/auth/forms.ts';
	import { toExpense, type LocalExpense } from '#lib/collections/views.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';
	import { recordExpense } from '#lib/sync/writes.ts';

	type Row = Record<string, unknown>;
	const t = fr.expenses;
	const today = toIsoDate();
	const role = $derived(organizations.active?.role);
	const combos = $derived(allowedExpenseCombinations(organizations.active?.type ?? 'agency'));

	let items = $state<LocalExpense[]>([]);
	let properties = $state<Row[]>([]);
	let units = $state<Row[]>([]);
	let leases = $state<Row[]>([]);
	let tenants = $state<Row[]>([]);
	let loaded = $state(false);
	let message = $state<string | null>(null);
	let info = $state<string | null>(null);

	onMount(() => {
		const org = organizations.activeId;
		const onError = (error: Error) => (message = messageOf(error));
		const stops = [
			sync.watch<Row>(LOCAL_QUERIES.expenses, [org], (r) => ((items = r.map(toExpense)), (loaded = true)), onError),
			sync.watch<Row>(LOCAL_QUERIES.properties, [org], (r) => (properties = r), onError),
			sync.watch<Row>(LOCAL_QUERIES.units, [org], (r) => (units = r), onError),
			sync.watch<Row>(LOCAL_QUERIES.leases, [org], (r) => (leases = r), onError),
			sync.watch<Row>(LOCAL_QUERIES.tenants, [org], (r) => (tenants = r), onError)
		];
		return () => stops.forEach((s) => s());
	});

	// ---- formulaire
	let formOpen = $state(false);
	let formMessage = $state<string | null>(null);
	let busy = $state(false);
	let propertyId = $state('');
	let unitId = $state('');
	let leaseId = $state('');
	let spentOn = $state(today);
	let category = $state<(typeof EXPENSE_CATEGORIES)[number]>('plumbing');
	let description = $state('');
	let supplier = $state('');
	let amount = $state('');
	let combo = $state(0);

	const chosen = $derived(combos[combo] ?? combos[0]!);
	const needsLease = $derived(expenseNeedsLease(chosen));
	const propertyUnits = $derived(units.filter((u) => u.property_id === propertyId));
	const tenantName = $derived(new Map(tenants.map((x) => [String(x.id), String(x.full_name ?? '')])));
	const unitIdsOfProperty = $derived(new Set(propertyUnits.map((u) => String(u.id))));
	const propertyLeases = $derived(
		leases.filter((l) => unitIdsOfProperty.has(String(l.unit_id)) && (!unitId || l.unit_id === unitId) && l.status !== 'draft')
	);

	function openForm() {
		formMessage = null;
		propertyId = String(properties[0]?.id ?? '');
		unitId = '';
		leaseId = '';
		spentOn = today;
		category = 'plumbing';
		description = '';
		supplier = '';
		amount = '';
		combo = 0;
		formOpen = true;
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		formMessage = null;
		const parsed = expenseSchema.safeParse({
			id: newId(),
			propertyId,
			unitId: unitId || null,
			leaseId: needsLease ? leaseId || null : null,
			spentOn,
			category,
			description,
			supplier,
			amount: parseFcfa(amount) ?? Number.NaN,
			paidBy: chosen.paidBy,
			borneBy: chosen.borneBy,
			recovery: chosen.recovery
		});
		if (!parsed.success) {
			formMessage = parsed.error.issues[0]?.message ?? fr.app.notFound;
			return;
		}
		busy = true;
		try {
			await recordExpense(sync.db ?? (await sync.start()), organizations.activeId!, parsed.data);
			formOpen = false;
			info = t.saved;
		} catch (error) {
			formMessage = messageOf(error);
		} finally {
			busy = false;
		}
	}

	// ---- annulation (directeur, en ligne)
	let cancelOf = $state<LocalExpense | null>(null);
	let cancelOpen = $state(false);
	let reason = $state('');
	async function cancel(e: SubmitEvent) {
		e.preventDefault();
		const parsed = cancelExpenseSchema.safeParse({ reason });
		if (!parsed.success || !cancelOf) {
			message = parsed.error?.issues[0]?.message ?? null;
			return;
		}
		try {
			await organizations.call('POST', `/expenses/${cancelOf.id}/cancel`, parsed.data);
			cancelOpen = false;
		} catch (error) {
			message = messageOf(error);
		}
	}

	const field = 'space-y-1';
	const select = 'min-h-11 w-full rounded-lg border bg-background px-3 text-base';
</script>

<PageHeader title={t.title} subtitle={t.subtitle}>
	{#snippet actions()}
		{#if can(role, 'expense.record')}
			<Button onclick={openForm} size="lg" data-testid="nouvelle-depense"><Plus class="size-5" aria-hidden="true" />{t.add}</Button>
		{/if}
	{/snippet}
</PageHeader>

<main class="page space-y-4 pt-3 pb-10" data-testid="depenses">
	{#if !can(role, 'expense.read')}
		<FormAlert message={fr.app.notFound} />
	{:else}
		<FormAlert {message} />
		<FormAlert message={info} tone="info" />
		{#if loaded && !items.length}
			<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground">{t.empty}</p>
		{:else if !device.isPhone}
			<div class="overflow-x-auto rounded-xl border bg-card">
				<table class="w-full text-left text-base">
					<thead class="border-b text-muted-foreground">
						<tr>
							<th class="px-4 py-3 font-medium">{t.columns.date}</th>
							<th class="px-4 py-3 font-medium">{t.columns.property}</th>
							<th class="px-4 py-3 font-medium">{t.columns.category}</th>
							<th class="px-4 py-3 text-right font-medium">{t.columns.amount}</th>
							{#if device.isDesktop}<th class="px-4 py-3 font-medium">{t.columns.effect}</th>{/if}
							<th class="px-4 py-3 font-medium">{t.columns.status}</th>
						</tr>
					</thead>
					<tbody class="divide-y">
						{#each items as e (e.id)}
							<tr data-testid="depense">
								<td class="px-4 py-3 whitespace-nowrap tabular-nums">{formatDate(e.spentOn)}</td>
								<td class="px-4 py-3">{e.propertyName}{e.unitLabel ? ` · ${e.unitLabel}` : ''}</td>
								<td class="px-4 py-3"
									>{EXPENSE_CATEGORY_LABELS[e.category]}<span class="block text-sm text-muted-foreground">{e.description}</span></td
								>
								<td class="px-4 py-3 text-right whitespace-nowrap tabular-nums">{formatFcfa(e.amount)}</td>
								{#if device.isDesktop}<td class="px-4 py-3 text-sm">{e.effect ? t.effects[e.effect] : ''}</td>{/if}
								<td class="px-4 py-3">
									{#if e.status === 'cancelled'}<Badge variant="danger">{t.cancelled}</Badge>
									{:else if can(role, 'expense.cancel')}
										<Button variant="outline" onclick={() => ((cancelOf = e), (reason = ''), (cancelOpen = true))} disabled={!sync.online}
											>{t.cancel}</Button
										>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<ul class="space-y-3">
				{#each items as e (e.id)}
					<li class="space-y-1 rounded-xl border bg-card p-4" data-testid="depense">
						<p class="flex flex-wrap items-center justify-between gap-2">
							<span class="font-semibold">{EXPENSE_CATEGORY_LABELS[e.category]}</span>
							<span class="font-semibold tabular-nums">{formatFcfa(e.amount)}</span>
						</p>
						<p class="text-sm break-words text-muted-foreground">
							{formatDate(e.spentOn)} · {e.propertyName}{e.unitLabel ? ` · ${e.unitLabel}` : ''}
						</p>
						<p class="text-base break-words">{e.description}</p>
						{#if e.effect}<p class="text-sm text-muted-foreground">{t.effects[e.effect]}</p>{/if}
						{#if e.status === 'cancelled'}<Badge variant="danger">{t.cancelled}</Badge>{/if}
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</main>

<Sheet bind:open={formOpen} labelledby="depense-titre" side="right">
	<form class="space-y-4" onsubmit={save} data-testid="formulaire-depense">
		<h2 id="depense-titre" class="pr-10 text-xl font-semibold">{t.add}</h2>
		<FormAlert message={formMessage} />
		<div class={field}>
			<label for="depense-bien" class="text-base font-medium">{t.property}</label>
			<select id="depense-bien" class={select} bind:value={propertyId} onchange={() => ((unitId = ''), (leaseId = ''))}>
				{#each properties as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
			</select>
		</div>
		<div class={field}>
			<label for="depense-unite" class="text-base font-medium">{t.unit}</label>
			<select id="depense-unite" class={select} bind:value={unitId}>
				<option value="">{t.wholeProperty}</option>
				{#each propertyUnits as u (u.id)}<option value={u.id}>{u.label}</option>{/each}
			</select>
		</div>
		<fieldset class="space-y-2">
			<legend class="text-base font-medium">{t.combination}</legend>
			{#each combos as c, i (`${c.paidBy}-${c.borneBy}-${c.recovery}`)}
				<label class="flex min-h-11 items-center gap-3 rounded-lg border-2 bg-card px-3 py-2 has-checked:border-primary">
					<input type="radio" name="combinaison" value={i} bind:group={combo} class="size-5 shrink-0" />{t.effects[c.effect]}
				</label>
			{/each}
		</fieldset>
		{#if needsLease}
			<div class={field}>
				<label for="depense-bail" class="text-base font-medium">{t.lease}</label>
				<select id="depense-bail" class={select} bind:value={leaseId} data-testid="depense-bail">
					<option value="">—</option>
					{#each propertyLeases as l (l.id)}<option value={l.id}>{tenantName.get(String(l.tenant_id)) ?? ''}</option>{/each}
				</select>
			</div>
		{/if}
		<div class="grid gap-3 sm:grid-cols-2">
			<div class={field}>
				<label for="depense-date" class="text-base font-medium">{t.date}</label>
				<Input id="depense-date" type="date" bind:value={spentOn} max={today} />
			</div>
			<div class={field}>
				<label for="depense-montant" class="text-base font-medium">{t.amount}</label>
				<Input id="depense-montant" inputmode="numeric" bind:value={amount} class="tabular-nums" data-testid="depense-montant" />
			</div>
		</div>
		<div class={field}>
			<label for="depense-categorie" class="text-base font-medium">{t.category}</label>
			<select id="depense-categorie" class={select} bind:value={category}>
				{#each EXPENSE_CATEGORIES as c (c)}<option value={c}>{EXPENSE_CATEGORY_LABELS[c]}</option>{/each}
			</select>
		</div>
		<div class={field}>
			<label for="depense-description" class="text-base font-medium">{t.description}</label>
			<Input id="depense-description" bind:value={description} maxlength={500} data-testid="depense-description" />
		</div>
		<div class={field}>
			<label for="depense-prestataire" class="text-base font-medium">{t.supplier}</label>
			<Input id="depense-prestataire" bind:value={supplier} maxlength={120} />
		</div>
		<Button type="submit" class="w-full" disabled={busy} data-testid="enregistrer-depense">{t.save}</Button>
	</form>
</Sheet>

<Sheet bind:open={cancelOpen} labelledby="annuler-depense-titre">
	<form class="space-y-4" onsubmit={cancel}>
		<h2 id="annuler-depense-titre" class="pr-10 text-xl font-semibold">{t.cancel}</h2>
		<div class={field}>
			<label for="annuler-motif" class="text-base font-medium">{t.cancelReason}</label>
			<Input id="annuler-motif" bind:value={reason} maxlength={500} />
		</div>
		<Button type="submit" variant="destructive" class="w-full" disabled={!sync.online}>{t.cancelConfirm}</Button>
		{#if !sync.online}<p class="text-sm text-muted-foreground">{t.onlineOnly}</p>{/if}
	</form>
</Sheet>
