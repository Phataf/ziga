<script lang="ts">
	/**
	 * Préavis et sorties (lot 10 bis, étape 4) : sorties en cours et closes, lues sur l'appareil ; unités « à remettre en
	 * état » (D14, règle 13) : jamais disponibles tant que le gestionnaire ne les déclare pas prêtes. Cartes sur téléphone,
	 * tableau sur ordinateur. L'agent de terrain n'y voit que ses unités, sans caution ni décompte.
	 */
	import { onMount } from 'svelte';
	import { ChevronRight, CircleAlert, CircleCheck, LogOut, Wrench } from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import { formatDate } from '@ziga/shared/dates';
	import { formatFcfa } from '@ziga/shared/money';
	import { can } from '@ziga/shared/permissions';
	import { technicalStatusSchema } from '@ziga/shared/properties';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { device } from '#lib/device.svelte.ts';
	import type { ExitStage } from '#lib/exit/views.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';
	import { setTechnicalStatus } from '#lib/sync/writes.ts';

	type Row = Record<string, unknown>;
	const t = fr.exit;
	const role = $derived(organizations.active?.role);

	let rows = $state<Row[]>([]);
	let units = $state<Row[]>([]);
	let loaded = $state(false);
	let message = $state<string | null>(null);
	let info = $state<string | null>(null);

	onMount(() => {
		const org = organizations.activeId;
		const onError = (error: Error) => (message = messageOf(error));
		const stops = [
			sync.watch<Row>(LOCAL_QUERIES.exits, [org], (r) => ((rows = r), (loaded = true)), onError),
			sync.watch<Row>(LOCAL_QUERIES.refurbishUnits, [org], (r) => (units = r), onError)
		];
		return () => stops.forEach((s) => s());
	});

	const stageOf = (r: Row): ExitStage =>
		r.settlement_status === 'closed'
			? 'closed'
			: r.settlement_status === 'disputed' || r.exit_inspection_status === 'disputed'
				? 'disputed'
				: r.settlement_status
					? 'settlement'
					: r.exit_inspection_status
						? 'inspection'
						: 'notice';
	const tone = (s: ExitStage) => (s === 'closed' ? 'success' : s === 'disputed' ? 'danger' : s === 'notice' ? 'warning' : 'info');
	const exitOn = (r: Row) => String(r.planned_exit_on ?? r.exit_on ?? '');
	const open = $derived(rows.filter((r) => stageOf(r) !== 'closed'));
	const closed = $derived(rows.filter((r) => stageOf(r) === 'closed'));

	async function declare(u: Row, status: 'ready' | 'under_works') {
		message = null;
		info = null;
		const parsed = technicalStatusSchema.safeParse(
			status === 'ready' ? { technicalStatus: 'ready' } : { technicalStatus: 'under_works', reason: t.refurbish.reasonDefault }
		);
		if (!parsed.success) return void (message = parsed.error.issues[0]!.message);
		try {
			await setTechnicalStatus(sync.db ?? (await sync.start()), organizations.activeId!, String(u.id), parsed.data);
			info = status === 'ready' ? t.refurbish.readyDone : t.saved;
		} catch (error) {
			message = messageOf(error);
		}
	}
</script>

{#snippet stage(r: Row)}
	{@const s = stageOf(r)}
	<span class="flex flex-wrap gap-1">
		<Badge variant={tone(s)}>{t.stages[s]}</Badge>
		{#if r.refund_alert && s !== 'closed'}<Badge variant="danger">{t.refundAlert[String(r.refund_alert)]}</Badge>{/if}
	</span>
{/snippet}

<PageHeader title={t.title} subtitle={t.subtitle} />

<main class="page space-y-6 pt-3 pb-10" data-testid="sorties">
	<FormAlert {message} />
	<FormAlert message={info} tone="info" />

	<section class="space-y-2" aria-labelledby="titre-en-cours">
		<h2 id="titre-en-cours" class="text-lg font-semibold">{t.list.inProgress}</h2>
		{#if loaded && !open.length}
			<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground">{t.list.empty}</p>
		{:else if device.isDesktop}
			<div class="overflow-x-auto rounded-xl border bg-card">
				<table class="w-full text-left text-base">
					<thead class="border-b text-muted-foreground">
						<tr>
							<th class="px-4 py-3 font-medium">{t.list.columns.tenant}</th>
							<th class="px-4 py-3 font-medium">{t.list.columns.unit}</th>
							<th class="px-4 py-3 font-medium">{t.list.columns.exitOn}</th>
							<th class="px-4 py-3 font-medium">{t.list.columns.stage}</th>
							<th class="px-4 py-3"><span class="sr-only">{t.open}</span></th>
						</tr>
					</thead>
					<tbody class="divide-y">
						{#each open as r (r.id)}
							<tr data-testid="sortie">
								<td class="px-4 py-3 font-semibold">{r.tenant_name}</td>
								<td class="px-4 py-3">{r.property_name} · {r.unit_label}</td>
								<td class="px-4 py-3 tabular-nums">{exitOn(r) ? formatDate(exitOn(r)) : ''}</td>
								<td class="px-4 py-3">{@render stage(r)}</td>
								<td class="px-4 py-3 text-right">
									<Button href={resolve('/app/sorties/[id]', { id: String(r.id) })} data-testid="ouvrir-sortie"
										><LogOut class="size-5" aria-hidden="true" />{t.open}</Button
									>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<ul class="grid grid-cols-1 gap-3 md:grid-cols-2">
				{#each open as r (r.id)}
					<li class="space-y-2 rounded-xl border bg-card p-4" data-testid="sortie">
						<div class="flex flex-wrap items-start justify-between gap-2">
							<div class="min-w-0">
								<p class="font-semibold break-words">{r.tenant_name}</p>
								<p class="text-base break-words text-muted-foreground">{r.property_name} · {r.unit_label}</p>
							</div>
							{@render stage(r)}
						</div>
						{#if exitOn(r)}<p class="text-base">{t.list.exitOn(formatDate(exitOn(r)))}</p>{/if}
						<Button class="w-full" href={resolve('/app/sorties/[id]', { id: String(r.id) })} data-testid="ouvrir-sortie"
							><LogOut class="size-5" aria-hidden="true" />{t.open}</Button
						>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="space-y-2" aria-labelledby="titre-remise-en-etat" data-testid="remise-en-etat">
		<h2 id="titre-remise-en-etat" class="flex items-center gap-2 text-lg font-semibold">
			<Wrench class="size-5" aria-hidden="true" />{t.refurbish.title}
		</h2>
		<p class="text-base text-muted-foreground">{t.refurbish.hint}</p>
		{#if !units.length}
			<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground">{t.refurbish.empty}</p>
		{:else}
			<ul class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
				{#each units as u (u.id)}
					<li class="space-y-2 rounded-xl border bg-card p-4" data-testid="unite-a-remettre">
						<p class="font-semibold break-words">{u.property_name} · {u.label}</p>
						<p class="flex flex-wrap gap-1">
							<Badge variant="warning">{fr.properties.technical[String(u.technical_status) as 'to_refurbish']}</Badge>
							<Badge variant="secondary"><CircleAlert class="size-4" aria-hidden="true" />{t.refurbish.notAvailable}</Badge>
						</p>
						{#if u.technical_reason}<p class="text-sm break-words text-muted-foreground">{u.technical_reason}</p>{/if}
						{#if can(role, 'unit.status')}
							<div class="flex flex-wrap gap-2">
								{#if u.technical_status === 'to_refurbish'}
									<Button variant="outline" onclick={() => declare(u, 'under_works')} data-testid="mettre-en-travaux"
										><Wrench class="size-5" aria-hidden="true" />{t.refurbish.works}</Button
									>
								{/if}
								<Button onclick={() => declare(u, 'ready')} data-testid="declarer-prete"
									><CircleCheck class="size-5" aria-hidden="true" />{t.refurbish.ready}</Button
								>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="space-y-2" aria-labelledby="titre-closes">
		<h2 id="titre-closes" class="text-lg font-semibold">{t.list.closed}</h2>
		<ul class="divide-y rounded-xl border bg-card">
			{#each closed as r (r.id)}
				<li>
					<a
						href={resolve('/app/sorties/[id]', { id: String(r.id) })}
						class="flex min-h-16 items-center gap-3 p-3 hover:bg-accent"
						data-testid="sortie-close"
					>
						<CircleCheck class="size-6 shrink-0 text-primary" aria-hidden="true" />
						<span class="min-w-0 flex-1">
							<span class="block font-semibold break-words">{r.tenant_name} · {r.unit_label}</span>
							<span class="block text-base text-muted-foreground">
								{exitOn(r) ? t.list.exitOn(formatDate(exitOn(r))) : ''}{r.settlement_refund !== null && r.settlement_refund !== undefined
									? ` · ${t.list.refunded(formatFcfa(Number(r.settlement_refund)))}`
									: ''}
							</span>
						</span>
						<ChevronRight class="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
					</a>
				</li>
			{:else}
				<li class="p-4 text-base text-muted-foreground">{t.list.emptyClosed}</li>
			{/each}
		</ul>
	</section>
</main>
