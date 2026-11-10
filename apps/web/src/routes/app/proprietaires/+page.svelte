<script lang="ts">
	/**
	 * Propriétaires (lot 06) : lus dans la base de l'appareil, sans appel réseau, pour l'organisation active seulement.
	 * Recherche sur l'appareil (nom sans accents, numéro) ; bandeau des mandats qui se terminent dans les 30 jours.
	 * Cartes sur téléphone et tablette, tableau sur ordinateur. Le bailleur particulier ne gère pas de propriétaires.
	 */
	import { onMount } from 'svelte';
	import { CircleAlert, Search, UserPlus } from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import { formatDate, toIsoDate } from '@ziga/shared/dates';
	import { formatRateBp, type MandateView, type OwnerView } from '@ziga/shared/owners';
	import { can } from '@ziga/shared/permissions';
	import { formatPhone } from '@ziga/shared/phone';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { currentMandate, expiringMandates, searchOwners, toMandate, toOwner } from '#lib/owners/views.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';

	const t = fr.owners;
	const tm = fr.mandates;
	const today = toIsoDate();
	const role = $derived(organizations.active?.role);
	const landlord = $derived(organizations.active?.type === 'landlord');
	const allowed = $derived(can(role, 'owner.read') && !landlord);
	const canCreate = $derived(can(role, 'owner.create'));

	let owners = $state<OwnerView[]>([]);
	let mandates = $state<MandateView[]>([]);
	let query = $state('');
	let message = $state<string | null>(null);

	onMount(() => {
		if (!allowed) return;
		const id = organizations.activeId;
		const onError = (error: Error) => (message = messageOf(error));
		const stopOwners = sync.watch<Record<string, unknown>>(LOCAL_QUERIES.owners, [id], (rows) => (owners = rows.map(toOwner)), onError);
		const stopMandates = sync.watch<Record<string, unknown>>(
			LOCAL_QUERIES.mandates,
			[id],
			(rows) => (mandates = rows.map(toMandate)),
			onError
		);
		return () => {
			stopOwners();
			stopMandates();
		};
	});

	const byOwner = $derived.by(() => {
		const out: Record<string, MandateView[]> = {};
		for (const m of mandates) (out[m.ownerId] ??= []).push(m);
		return out;
	});
	const shown = $derived(searchOwners(owners, query));
	const expiring = $derived(expiringMandates(mandates, today));
	const nameOf = (id: string) => owners.find((o) => o.id === id)?.name ?? '';

	function summary(o: OwnerView): string {
		const m = currentMandate(byOwner[o.id] ?? [], today);
		if (!m) return t.noMandate;
		const c = m.commission;
		const rate = c?.basis === 'percent_of_collected' ? ` · ${formatRateBp(c.rateBp)}` : '';
		return `${tm.types[m.type]}${rate}`;
	}
</script>

<PageHeader title={t.title} subtitle={t.subtitle}>
	{#snippet actions()}
		{#if allowed && canCreate && !device.isPhone}
			<Button href={resolve('/app/proprietaires/nouveau')}><UserPlus aria-hidden="true" />{t.new}</Button>
		{/if}
	{/snippet}
</PageHeader>

<main class="page space-y-4 pt-3 pb-10" data-testid="proprietaires">
	{#if !allowed}
		<FormAlert message={landlord ? t.landlord : fr.app.notFound} tone={landlord ? 'info' : undefined} />
	{:else}
		<FormAlert {message} />
		{#if !canCreate}<FormAlert message={t.readOnly} tone="info" />{/if}
		{#if canCreate && device.isPhone}
			<Button size="lg" class="w-full" href={resolve('/app/proprietaires/nouveau')}><UserPlus aria-hidden="true" />{t.new}</Button>
		{/if}

		{#if expiring.length}
			<section class="space-y-2 rounded-xl border border-warning bg-warning-soft p-4 text-warning-foreground" data-testid="bandeau-mandats">
				<h2 class="flex items-center gap-2 font-semibold">
					<CircleAlert class="size-5" aria-hidden="true" />{t.expiring(expiring.length)}
				</h2>
				<ul class="space-y-1">
					{#each expiring as e (e.mandateId)}
						<li>
							<a class="inline-flex min-h-11 items-center text-base underline" href={resolve('/app/proprietaires/[id]', { id: e.ownerId })}
								>{t.expiringLine(nameOf(e.ownerId), formatDate(e.endsOn), e.daysLeft)}</a
							>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		<div class="relative">
			<Search class="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
			<Input type="search" bind:value={query} placeholder={t.search} aria-label={t.search} class="pl-10" data-testid="recherche" />
		</div>

		{#if !owners.length}
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
							<th class="px-4 py-3 font-medium">{tm.title}</th>
							<th class="px-4 py-3 font-medium"><span class="sr-only">{t.archived}</span></th>
						</tr>
					</thead>
					<tbody class="divide-y">
						{#each shown as o (o.id)}
							<tr data-testid="proprietaire">
								<td class="px-4 py-3">
									<a class="font-medium underline-offset-2 hover:underline" href={resolve('/app/proprietaires/[id]', { id: o.id })}
										>{o.name}</a
									>
									<span class="block text-sm text-muted-foreground">{t.types[o.type]}</span>
								</td>
								<td class="px-4 py-3 whitespace-nowrap tabular-nums">{formatPhone(o.phone)}</td>
								<td class="px-4 py-3">{summary(o)}</td>
								<td class="px-4 py-3"
									>{#if o.status === 'archived'}<Badge variant="secondary">{t.archived}</Badge>{/if}</td
								>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<ul class="space-y-3">
				{#each shown as o (o.id)}
					<li data-testid="proprietaire">
						<a
							class="block space-y-1 rounded-xl border bg-card p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
							href={resolve('/app/proprietaires/[id]', { id: o.id })}
						>
							<span class="flex flex-wrap items-center justify-between gap-2">
								<span class="font-semibold break-words">{o.name}</span>
								{#if o.status === 'archived'}<Badge variant="secondary">{t.archived}</Badge>{/if}
							</span>
							<span class="block text-base tabular-nums">{formatPhone(o.phone)}</span>
							<span class="block text-sm text-muted-foreground">{summary(o)}</span>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</main>
