<script lang="ts">
	/**
	 * Assistant de transfert de gestion (lot 10 bis, étape 4 ; D16, règles 12 et 15) : périmètre (bien ou unité), dossier
	 * remis au nouveau gestionnaire, changement de détenteur de la caution, confirmation. Le plan affiché vient de la même
	 * fonction que le serveur (managementTransferPlan). Tout s'écrit chez cette organisation seulement : elle garde son
	 * historique, et rien n'est copié vers le nouveau gestionnaire, nommé en texte. Enregistré en ligne.
	 */
	import { onMount } from 'svelte';
	import { CircleCheck, Plus, Trash2 } from '@lucide/svelte';
	import { page } from '$app/state';
	import { formatDate, toIsoDate } from '@ziga/shared/dates';
	import { managementTransferSchema } from '@ziga/shared/exit-schemas';
	import { newId } from '@ziga/shared/ids';
	import type { DepositMovementView } from '@ziga/shared/leases';
	import { formatFcfa } from '@ziga/shared/money';
	import { can } from '@ziga/shared/permissions';
	import { managementTransferBlocker, managementTransferPlan, type ManagementTransferInput } from '@ziga/shared/tenant-exit';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { toDepositAccount, toMovement } from '#lib/leases/views.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';

	type Row = Record<string, unknown>;
	const t = fr.exit.transfer;
	const today = toIsoDate();
	const mandateId = $derived(page.params.mandateId ?? '');
	const role = $derived(organizations.active?.role);

	let mandate = $state<Row | null>(null);
	let scopes = $state<Row[]>([]);
	let properties = $state<Row[]>([]);
	let units = $state<Row[]>([]);
	let transfers = $state<Row[]>([]);
	let leases = $state<Row[]>([]);
	let accountRows = $state<Row[]>([]);
	let movements = $state<DepositMovementView[]>([]);
	let loaded = $state(false);
	let message = $state<string | null>(null);
	let done = $state(false);
	let busy = $state(false);

	onMount(() => {
		const org = organizations.activeId;
		const onError = (error: Error) => (message = messageOf(error));
		const stops = [
			sync.watch<Row>(LOCAL_QUERIES.mandate, [org, mandateId], (r) => ((mandate = r[0] ?? null), (loaded = true)), onError),
			sync.watch<Row>(LOCAL_QUERIES.mandateScopes, [org, mandateId], (r) => (scopes = r), onError),
			sync.watch<Row>(LOCAL_QUERIES.mandateTransfers, [org, mandateId], (r) => (transfers = r), onError),
			sync.watch<Row>(LOCAL_QUERIES.properties, [org], (r) => (properties = r), onError),
			sync.watch<Row>(LOCAL_QUERIES.units, [org], (r) => (units = r), onError)
		];
		return () => stops.forEach((s) => s());
	});

	/** Portées de gestion encore actives (une portée terminée par un transfert ne compte plus). */
	const activeScopes = $derived(scopes.filter((s) => !s.ended_on && s.management_active !== 0));
	const propertyIds = $derived([...new Set(activeScopes.map((s) => String(s.property_id)))]);
	let step = $state(0);
	let propertyId = $state('');
	let unitId = $state('');
	let transferOn = $state(today);
	let newManagerName = $state('');
	let handedOverOn = $state(today);
	let handedOverItems = $state<string[]>([...t.itemsDefault]);
	let note = $state('');

	$effect(() => {
		if (!propertyId && propertyIds[0]) propertyId = propertyIds[0];
	});
	$effect(() => {
		const org = organizations.activeId;
		if (!propertyId) return;
		const stops = [
			sync.watch<Row>(LOCAL_QUERIES.propertyLeases, [org, propertyId], (r) => (leases = r)),
			sync.watch<Row>(LOCAL_QUERIES.propertyDeposits, [org, propertyId], (r) => (accountRows = r)),
			sync.watch<Row>(LOCAL_QUERIES.propertyMovements, [org, propertyId], (r) => (movements = r.map(toMovement)))
		];
		return () => stops.forEach((s) => s());
	});

	const propertyName = (id: string) => String(properties.find((p) => p.id === id)?.name ?? '');
	const propertyUnits = $derived(units.filter((u) => u.property_id === propertyId));
	const inForce = $derived(leases.filter((l) => l.status === 'active' || l.status === 'notice'));
	const accounts = $derived(accountRows.map((r) => toDepositAccount(r, movements, 0)));
	const input = $derived<ManagementTransferInput>({
		target: { propertyId, unitId: unitId || null },
		mandate: mandate
			? {
					id: String(mandate.id),
					status: String(mandate.status ?? 'active'),
					scopes: activeScopes.map((s) => ({
						id: String(s.id),
						propertyId: String(s.property_id),
						unitId: s.unit_id ? String(s.unit_id) : null
					}))
				}
			: null,
		transferOn,
		today,
		newManagerName,
		handedOverOn,
		handedOverItems,
		leasesInForce: inForce.map((l) => ({ id: String(l.id), unitId: String(l.unit_id) })),
		depositAccounts: accounts.map((a) => ({ id: a.id, leaseId: a.leaseId, holder: a.holder, held: a.balances.held, status: a.status }))
	});
	const blocker = $derived(managementTransferBlocker(input));
	const plan = $derived(managementTransferPlan(input));
	const heldOf = (accountId: string) => accounts.find((a) => a.id === accountId)?.balances.held ?? 0;
	const steps = [t.steps.scope, t.steps.dossier, t.steps.deposit, t.steps.confirm];
	/** Ce qui empêche de passer à l'étape suivante : périmètre géré, puis dossier complet. */
	const stepBlocker = $derived(
		step === 0 ? (blocker === 'TRANSFER_NOT_MANAGED' || blocker === 'TRANSFER_DATE_INVALID' ? blocker : null) : step === 1 ? blocker : null
	);

	async function submit() {
		message = null;
		const parsed = managementTransferSchema.safeParse({
			id: newId(),
			propertyId,
			unitId: unitId || null,
			transferOn,
			newManagerName,
			handedOverOn,
			handedOverItems: handedOverItems.map((i) => i.trim()).filter(Boolean),
			note
		});
		if (!parsed.success) return void (message = parsed.error.issues[0]!.message);
		busy = true;
		try {
			await organizations.call('POST', `/mandates/${mandateId}/transfer`, parsed.data);
			done = true;
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}

	const field = 'space-y-1';
	const select = 'min-h-11 w-full rounded-lg border bg-background px-3 text-base';
</script>

<PageHeader title={t.title} back="app/proprietaires" backLabel={fr.nav.owners} />

<main class="page space-y-4 pt-3 pb-10" data-testid="transfert-gestion">
	<FormAlert {message} />
	{#if !can(role, 'management.transfer')}
		<FormAlert message={fr.app.notFound} />
	{:else if loaded && (!mandate || mandate.type !== 'rental_management')}
		<FormAlert message={t.notManagement} />
	{:else if done}
		<section class="space-y-2 rounded-xl border bg-card p-4" data-testid="transfert-enregistre">
			<p class="flex items-center gap-2 text-lg font-semibold"><CircleCheck class="size-6 text-primary" aria-hidden="true" />{t.done}</p>
			<p class="text-base">{t.nothingCopied}</p>
		</section>
	{:else if mandate}
		<p class="text-base text-muted-foreground">{t.hint}</p>
		<ol class="flex flex-wrap gap-2" aria-label={t.title}>
			{#each steps as s, i (s)}
				<li
					class="rounded-full border-2 px-3 py-1 text-sm font-medium {i === step
						? 'border-primary bg-primary text-primary-foreground'
						: 'border-input'}"
					aria-current={i === step ? 'step' : undefined}
				>
					{i + 1}. {s}
				</li>
			{/each}
		</ol>
		<section class="space-y-4 rounded-xl border bg-card p-4 md:p-6" aria-labelledby="titre-etape">
			<h2 id="titre-etape" class="text-lg font-semibold">{t.step(step + 1, steps.length, steps[step]!)}</h2>
			{#if step === 0}
				<div class={field}>
					<label for="transfert-bien" class="text-base font-medium">{t.property}</label>
					<select id="transfert-bien" class={select} bind:value={propertyId} onchange={() => (unitId = '')}>
						{#each propertyIds as p (p)}<option value={p}>{propertyName(p)}</option>{/each}
					</select>
				</div>
				<div class={field}>
					<label for="transfert-unite" class="text-base font-medium">{t.unit}</label>
					<select id="transfert-unite" class={select} bind:value={unitId}>
						<option value="">{t.wholeProperty}</option>
						{#each propertyUnits as u (u.id)}<option value={u.id}>{u.label}</option>{/each}
					</select>
				</div>
				<div class={field}>
					<label for="transfert-date" class="text-base font-medium">{t.transferOn}</label>
					<Input id="transfert-date" type="date" bind:value={transferOn} max={today} />
				</div>
				<p class="text-base">{plan.mandateAction === 'end_mandate' ? t.endMandate : t.endScope}</p>
				<p class="text-base" data-testid="transfert-baux">{t.leases(plan.leaseIds.length)}</p>
			{:else if step === 1}
				<div class={field}>
					<label for="transfert-gestionnaire" class="text-base font-medium">{t.newManager}</label>
					<Input id="transfert-gestionnaire" bind:value={newManagerName} maxlength={120} data-testid="transfert-gestionnaire" />
				</div>
				<div class={field}>
					<label for="transfert-remise" class="text-base font-medium">{t.handedOverOn}</label>
					<Input id="transfert-remise" type="date" bind:value={handedOverOn} max={today} />
				</div>
				<fieldset class="space-y-2">
					<legend class="text-base font-medium">{t.items}</legend>
					{#each handedOverItems as _, i (i)}
						<div class="flex items-center gap-2">
							<Input bind:value={handedOverItems[i]} maxlength={200} aria-label="{t.items} {i + 1}" />
							<Button
								variant="ghost"
								onclick={() => (handedOverItems = handedOverItems.filter((_, j) => j !== i))}
								aria-label="{fr.exit.inspection.removeElement} {i + 1}"><Trash2 class="size-5" aria-hidden="true" /></Button
							>
						</div>
					{/each}
					<Button variant="outline" onclick={() => (handedOverItems = [...handedOverItems, ''])}
						><Plus class="size-5" aria-hidden="true" />{t.addItem}</Button
					>
				</fieldset>
				<div class={field}>
					<label for="transfert-note" class="text-base font-medium">{t.note}</label>
					<Input id="transfert-note" bind:value={note} maxlength={1000} />
				</div>
			{:else if step === 2}
				{#if !plan.holderChanges.length}
					<p class="text-base">{t.noDeposit}</p>
				{:else}
					<ul class="space-y-2">
						{#each plan.holderChanges as h (h.accountId)}
							<li class="rounded-lg bg-muted p-3 text-base" data-testid="transfert-caution">
								{t.depositChange(formatFcfa(heldOf(h.accountId)), h.newHolderName)}
							</li>
						{/each}
					</ul>
				{/if}
				<p class="text-base">{t.nothingCopied}</p>
			{:else}
				<dl class="grid gap-2 text-base sm:grid-cols-2" data-testid="transfert-recapitulatif">
					<div class="rounded-lg bg-muted p-3">
						<dt class="text-sm text-muted-foreground">{t.property}</dt>
						<dd class="font-semibold">
							{propertyName(propertyId)}{unitId ? ` · ${String(units.find((u) => u.id === unitId)?.label ?? '')}` : ''}
						</dd>
					</div>
					<div class="rounded-lg bg-muted p-3">
						<dt class="text-sm text-muted-foreground">{t.newManager}</dt>
						<dd class="font-semibold">{newManagerName}</dd>
					</div>
					<div class="rounded-lg bg-muted p-3">
						<dt class="text-sm text-muted-foreground">{t.transferOn}</dt>
						<dd class="font-semibold">{formatDate(transferOn)}</dd>
					</div>
					<div class="rounded-lg bg-muted p-3">
						<dt class="text-sm text-muted-foreground">{t.items}</dt>
						<dd class="font-semibold">{handedOverItems.filter(Boolean).join(', ')}</dd>
					</div>
				</dl>
				<p class="text-base">{plan.mandateAction === 'end_mandate' ? t.endMandate : t.endScope}</p>
				<p class="text-base">{t.leases(plan.leaseIds.length)}</p>
				<p class="text-base">{t.nothingCopied}</p>
			{/if}
			{#if stepBlocker}<FormAlert message={t.blockers[stepBlocker] ?? null} />{/if}
			<div class="flex flex-wrap gap-2">
				{#if step > 0}<Button variant="outline" onclick={() => (step -= 1)}>{t.previous}</Button>{/if}
				{#if step < steps.length - 1}
					<Button onclick={() => (step += 1)} disabled={!!stepBlocker} data-testid="transfert-suivant">{t.next}</Button>
				{:else}
					<Button onclick={submit} disabled={busy || !!blocker || !sync.online} data-testid="enregistrer-transfert">{t.submit}</Button>
				{/if}
			</div>
			{#if !sync.online}<p class="text-sm text-muted-foreground">{fr.exit.onlineOnly}</p>{/if}
		</section>
		{#if transfers.length}
			<section class="space-y-2 rounded-xl border bg-card p-4">
				<h2 class="text-lg font-semibold">{t.history}</h2>
				<ul class="space-y-1">
					{#each transfers as tr (tr.id)}<li class="text-base">{formatDate(String(tr.transfer_on))} · {tr.new_manager_name}</li>{/each}
				</ul>
			</section>
		{/if}
	{/if}
</main>
