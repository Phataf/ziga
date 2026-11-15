<script lang="ts">
	/**
	 * Locataires (lot 08) : lus dans la base de l'appareil, sans appel réseau, pour l'organisation active seulement.
	 * Recherche sur l'appareil (nom sans accents, numéro) ; reste à payer exigible calculé sur l'appareil. Cartes sur
	 * téléphone et tablette, tableau sur ordinateur. L'agent de terrain ne reçoit que les locataires de ses unités.
	 */
	import { onMount } from 'svelte';
	import { Search } from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import { toIsoDate } from '@ziga/shared/dates';
	import { outstandingBalance, type TenantView } from '@ziga/shared/leases';
	import { formatFcfa } from '@ziga/shared/money';
	import { can } from '@ziga/shared/permissions';
	import { formatPhone } from '@ziga/shared/phone';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { searchTenants, toTenant } from '#lib/leases/views.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';

	type Row = Record<string, unknown>;
	const t = fr.tenants;
	const today = toIsoDate();
	const allowed = $derived(can(organizations.active?.role, 'tenant.read'));

	let tenants = $state<TenantView[]>([]);
	let leaseTenant = $state<Record<string, string>>({});
	let dues = $state<Row[]>([]);
	let query = $state('');
	let message = $state<string | null>(null);

	onMount(() => {
		if (!allowed) return;
		const id = organizations.activeId;
		const onError = (error: Error) => (message = messageOf(error));
		const stops = [
			sync.watch<Row>(LOCAL_QUERIES.tenants, [id], (rows) => (tenants = rows.map(toTenant)), onError),
			sync.watch<Row>(
				LOCAL_QUERIES.leases,
				[id],
				(rows) => (leaseTenant = Object.fromEntries(rows.map((r) => [String(r.id), String(r.tenant_id)]))),
				onError
			),
			sync.watch<Row>(LOCAL_QUERIES.dues, [id], (rows) => (dues = rows), onError)
		];
		return () => stops.forEach((stop) => stop());
	});

	/** Reste à payer exigible de chaque locataire, tous ses baux confondus. */
	const outstanding = $derived.by(() => {
		const byTenant: Record<string, { dueOn: string; amountDue: number; amountPaid: number; waived: boolean }[]> = {};
		for (const d of dues) {
			const tenantId = leaseTenant[String(d.lease_id)];
			if (!tenantId) continue;
			(byTenant[tenantId] ??= []).push({
				dueOn: String(d.due_on),
				amountDue: Number(d.amount_due ?? 0),
				amountPaid: Number(d.amount_paid ?? 0),
				waived: d.status === 'waived'
			});
		}
		return Object.fromEntries(Object.entries(byTenant).map(([k, v]) => [k, outstandingBalance(v, today)]));
	});
	const shown = $derived(searchTenants(tenants, query));
	const balance = (id: string) => outstanding[id] ?? 0;
</script>

<PageHeader title={t.title} subtitle={t.subtitle} />

<main class="page space-y-4 pt-3 pb-10" data-testid="locataires">
	{#if !allowed}
		<FormAlert message={fr.app.notFound} />
	{:else}
		<FormAlert {message} />
		<div class="relative">
			<Search class="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
			<Input type="search" bind:value={query} placeholder={t.search} aria-label={t.search} class="pl-10" data-testid="recherche" />
		</div>

		{#if !tenants.length}
			<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground">{t.empty}</p>
		{:else if !shown.length}
			<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground">{t.noResult}</p>
		{:else if device.isDesktop}
			<div class="overflow-x-auto rounded-xl border bg-card">
				<table class="w-full text-left text-base">
					<thead class="border-b text-muted-foreground">
						<tr>
							<th class="px-4 py-3 font-medium">{t.name}</th>
							<th class="px-4 py-3 font-medium">{t.phone}</th>
							<th class="px-4 py-3 text-right font-medium">{t.outstanding}</th>
							<th class="px-4 py-3 font-medium"><span class="sr-only">{t.archived}</span></th>
						</tr>
					</thead>
					<tbody class="divide-y">
						{#each shown as tn (tn.id)}
							<tr data-testid="locataire">
								<td class="px-4 py-3">
									<a class="font-medium underline-offset-2 hover:underline" href={resolve('/app/locataires/[id]', { id: tn.id })}
										>{tn.fullName}</a
									>
								</td>
								<td class="px-4 py-3 whitespace-nowrap tabular-nums">{tn.phone ? formatPhone(tn.phone) : ''}</td>
								<td class="px-4 py-3 text-right whitespace-nowrap tabular-nums"
									>{balance(tn.id) ? formatFcfa(balance(tn.id)) : t.nothingDue}</td
								>
								<td class="px-4 py-3"
									>{#if tn.status === 'archived'}<Badge variant="secondary">{t.archived}</Badge>{/if}</td
								>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<ul class="space-y-3">
				{#each shown as tn (tn.id)}
					<li data-testid="locataire">
						<a
							class="block space-y-1 rounded-xl border bg-card p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
							href={resolve('/app/locataires/[id]', { id: tn.id })}
						>
							<span class="flex flex-wrap items-center justify-between gap-2">
								<span class="font-semibold break-words">{tn.fullName}</span>
								{#if tn.status === 'archived'}<Badge variant="secondary">{t.archived}</Badge>{/if}
							</span>
							{#if tn.phone}<span class="block text-base tabular-nums">{formatPhone(tn.phone)}</span>{/if}
							<span class="block text-sm text-muted-foreground"
								>{t.outstanding} : {balance(tn.id) ? formatFcfa(balance(tn.id)) : t.nothingDue}</span
							>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</main>
