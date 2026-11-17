<script lang="ts">
	/**
	 * Relevés propriétaires (lot 10, docs/RELEVES.md) : pour un mois terminé, chaque propriétaire sous mandat et l'état
	 * de son relevé (à préparer, brouillon, émis), lus sur l'appareil. « Préparer le relevé » calcule le brouillon sur le
	 * serveur (en ligne), puis ouvre le relevé. Téléphone : mois en pastilles, propriétaires en cartes ; tablette : mois
	 * en liste à gauche ; ordinateur : mois à gauche et tableau avec les nets.
	 */
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { toIsoDate } from '@ziga/shared/dates';
	import { formatSignedFcfa } from '@ziga/shared/money';
	import { can } from '@ziga/shared/permissions';
	import { monthLabel, type StatementDetailView } from '@ziga/shared/statements';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import FeatureGate from '#lib/components/FeatureGate.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { latestByOwner, ownersWithStatement, recentMonths, toStatement, type LocalStatement } from '#lib/collections/views.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';

	type Row = Record<string, unknown>;
	const t = fr.statements;
	const months = recentMonths(toIsoDate(), 12);
	const role = $derived(organizations.active?.role);

	let month = $state(months[0]!);
	let statements = $state<LocalStatement[]>([]);
	let mandates = $state<Row[]>([]);
	let owners = $state<Row[]>([]);
	let message = $state<string | null>(null);
	let busy = $state<string | null>(null);

	onMount(() => {
		const org = organizations.activeId;
		const onError = (error: Error) => (message = messageOf(error));
		const stops = [
			sync.watch<Row>(LOCAL_QUERIES.statements, [org], (r) => (statements = r.map(toStatement)), onError),
			sync.watch<Row>(LOCAL_QUERIES.mandates, [org], (r) => (mandates = r), onError),
			sync.watch<Row>(LOCAL_QUERIES.owners, [org], (r) => (owners = r), onError)
		];
		return () => stops.forEach((s) => s());
	});

	const ownerName = $derived(new Map(owners.map((o) => [String(o.id), String(o.name ?? '')])));
	const latest = $derived(latestByOwner(statements, month));
	const rows = $derived(
		[...new Set([...ownersWithStatement(mandates, month), ...latest.keys()])]
			.map((ownerId) => ({
				ownerId,
				name: ownerName.get(ownerId) || latest.get(ownerId)?.ownerName || '',
				statement: latest.get(ownerId) ?? null
			}))
			.sort((a, b) => a.name.localeCompare(b.name, 'fr'))
	);

	async function prepare(ownerId: string) {
		busy = ownerId;
		message = null;
		try {
			const s = await organizations.call<StatementDetailView>('POST', '/owner-statements/generate', { ownerId, month });
			await goto(resolve('/app/releves/[id]', { id: s.id }));
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = null;
		}
	}

	function statusOf(s: LocalStatement | null) {
		if (!s) return { label: t.status.none, variant: 'outline' as const };
		return s.status === 'issued'
			? { label: t.status.issued, variant: 'success' as const }
			: { label: t.status.draft, variant: 'warning' as const };
	}
</script>

{#snippet action(r: (typeof rows)[number])}
	{#if r.statement}
		<Button variant="outline" href={resolve('/app/releves/[id]', { id: r.statement.id })}>{t.open}</Button>
	{:else if can(role, 'statement.issue')}
		<Button onclick={() => prepare(r.ownerId)} disabled={!sync.online || busy !== null} data-testid="preparer-releve">{t.prepare}</Button>
	{/if}
{/snippet}

<PageHeader title={t.title} subtitle={t.subtitle} />

<main class="page pt-3 pb-10" data-testid="releves">
	<FeatureGate key="collections.owner_statements">
		{#if !can(role, 'statement.read') || organizations.active?.type === 'landlord'}
			<FormAlert message={fr.app.notFound} />
		{:else}
			<div class={device.isPhone ? 'space-y-4' : 'grid grid-cols-[14rem_1fr] gap-6'}>
				<nav aria-label={t.monthsLabel}>
					{#if device.isPhone}
						<div class="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
							{#each months as m (m)}
								<button
									type="button"
									class="min-h-11 shrink-0 rounded-full border px-4 text-base {m === month
										? 'border-primary bg-primary text-primary-foreground'
										: 'bg-card'}"
									aria-pressed={m === month}
									onclick={() => (month = m)}>{monthLabel(m)}</button
								>
							{/each}
						</div>
					{:else}
						<ul class="space-y-1">
							{#each months as m (m)}
								<li>
									<button
										type="button"
										class="flex min-h-11 w-full items-center rounded-lg px-3 text-left text-base {m === month
											? 'bg-accent font-semibold text-accent-foreground'
											: 'hover:bg-muted'}"
										aria-current={m === month ? 'true' : undefined}
										onclick={() => (month = m)}>{monthLabel(m)}</button
									>
								</li>
							{/each}
						</ul>
					{/if}
				</nav>

				<section class="min-w-0 space-y-3">
					<h2 class="text-lg font-semibold">{monthLabel(month)}</h2>
					<FormAlert {message} />
					{#if !sync.online && can(role, 'statement.issue')}<p class="text-sm text-muted-foreground">{t.onlineOnly}</p>{/if}
					{#if !rows.length}
						<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground">{t.empty}</p>
					{:else if device.isDesktop}
						<div class="overflow-x-auto rounded-xl border bg-card">
							<table class="w-full text-left text-base">
								<thead class="border-b text-muted-foreground">
									<tr>
										<th class="px-4 py-3 font-medium">{fr.nav.owners}</th>
										<th class="px-4 py-3 font-medium">{t.statusLabel}</th>
										<th class="px-4 py-3 text-right font-medium">{t.net}</th>
										<th class="px-4 py-3"><span class="sr-only">{t.open}</span></th>
									</tr>
								</thead>
								<tbody class="divide-y">
									{#each rows as r (r.ownerId)}
										{@const st = statusOf(r.statement)}
										<tr data-testid="releve-proprietaire">
											<td class="px-4 py-3">{r.name}</td>
											<td class="px-4 py-3"><Badge variant={st.variant}>{st.label}</Badge></td>
											<td class="px-4 py-3 text-right tabular-nums">{r.statement ? formatSignedFcfa(r.statement.net) : ''}</td>
											<td class="px-4 py-3 text-right">{@render action(r)}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					{:else}
						<ul class="space-y-3">
							{#each rows as r (r.ownerId)}
								{@const st = statusOf(r.statement)}
								<li
									class="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4"
									data-testid="releve-proprietaire"
								>
									<span class="min-w-0 space-y-1">
										<span class="block font-semibold break-words">{r.name}</span>
										<span class="flex flex-wrap items-center gap-2">
											<Badge variant={st.variant}>{st.label}</Badge>
											{#if r.statement}<span class="tabular-nums">{formatSignedFcfa(r.statement.net)}</span>{/if}
										</span>
									</span>
									{@render action(r)}
								</li>
							{/each}
						</ul>
					{/if}
				</section>
			</div>
		{/if}
	</FeatureGate>
</main>
