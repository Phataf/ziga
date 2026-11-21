<script lang="ts">
	/**
	 * Comparaison entrée et sortie (lot 10 bis, étape 4) : pièce par pièce, élément par élément, par la fonction pure de
	 * packages/shared (même pièce et même élément, sans accents ni casse). Tableau sur ordinateur, cartes ailleurs ; lue
	 * sur l'appareil, hors ligne compris.
	 */
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { compareInspections } from '@ziga/shared/tenant-exit';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { device } from '#lib/device.svelte.ts';
	import { elementLabel, toInspection, toItem, type LocalInspection, type LocalItem } from '#lib/exit/views.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';

	type Row = Record<string, unknown>;
	const t = fr.exit.compare;
	const leaseId = $derived(page.params.id ?? '');

	let inspections = $state<LocalInspection[]>([]);
	let items = $state<LocalItem[]>([]);
	let message = $state<string | null>(null);

	onMount(() => {
		const org = organizations.activeId;
		const onError = (error: Error) => (message = messageOf(error));
		const stops = [
			sync.watch<Row>(LOCAL_QUERIES.leaseInspections, [org, leaseId], (r) => (inspections = r.map(toInspection)), onError),
			sync.watch<Row>(LOCAL_QUERIES.leaseInspectionItems, [org, leaseId], (r) => (items = r.map(toItem)), onError)
		];
		return () => stops.forEach((s) => s());
	});

	const entry = $derived(inspections.find((i) => i.type === 'entry') ?? null);
	const exit = $derived(inspections.find((i) => i.type === 'exit') ?? null);
	const rows = $derived(
		compareInspections(
			entry ? items.filter((i) => i.inspectionId === entry.id) : [],
			exit ? items.filter((i) => i.inspectionId === exit.id) : []
		)
	);
	const finding = (f: string | null | undefined) => (f ? fr.exit.inspection.findings[f] : null);
</script>

<PageHeader title={t.title} back="app/sorties" backLabel={fr.exit.back} />

<main class="page space-y-4 pt-3 pb-10" data-testid="comparaison">
	<FormAlert {message} />
	{#if !entry}<FormAlert message={t.missingEntry} tone="info" />{/if}
	{#if device.isDesktop}
		<div class="overflow-x-auto rounded-xl border bg-card">
			<table class="w-full text-left text-base">
				<thead class="border-b text-muted-foreground">
					<tr>
						<th class="px-4 py-3 font-medium">{fr.exit.inspection.roomName}</th>
						<th class="px-4 py-3 font-medium">{fr.exit.inspection.elementName}</th>
						<th class="px-4 py-3 font-medium">{t.entry}</th>
						<th class="px-4 py-3 font-medium">{t.exit}</th>
					</tr>
				</thead>
				<tbody class="divide-y">
					{#each rows as r, i (i)}
						<tr data-testid="ligne-comparaison">
							<td class="px-4 py-3">{r.room}</td>
							<td class="px-4 py-3 font-medium">{elementLabel(r.element)}</td>
							<td class="px-4 py-3">{r.entry?.description ?? t.absent}</td>
							<td class="px-4 py-3">
								{#if r.exit}
									{#if finding(r.exit.finding)}<Badge variant={r.exit.finding === 'tenant_damage' ? 'warning' : 'secondary'}>{finding(r.exit.finding)}</Badge>{/if}
									<span class="block">{r.exit.description}</span>
								{:else}{t.absent}{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<ul class="space-y-3">
			{#each rows as r, i (i)}
				<li class="space-y-2 rounded-xl border bg-card p-4" data-testid="ligne-comparaison">
					<p class="font-semibold break-words">{r.room} · {elementLabel(r.element)}</p>
					<div class="grid gap-2 md:grid-cols-2">
						<div class="rounded-lg bg-muted p-3">
							<p class="text-sm text-muted-foreground">{t.entry}</p>
							<p class="text-base break-words">{r.entry?.description ?? t.absent}</p>
						</div>
						<div class="rounded-lg bg-muted p-3">
							<p class="text-sm text-muted-foreground">{t.exit}</p>
							{#if r.exit}
								{#if finding(r.exit.finding)}<Badge variant={r.exit.finding === 'tenant_damage' ? 'warning' : 'secondary'}>{finding(r.exit.finding)}</Badge>{/if}
								<p class="text-base break-words">{r.exit.description}</p>
							{:else}<p class="text-base">{t.absent}</p>{/if}
						</div>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</main>
