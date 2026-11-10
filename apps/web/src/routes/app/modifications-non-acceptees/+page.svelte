<script lang="ts">
	/**
	 * Modifications non acceptées (lot 05, étape 4, docs/SYNC.md §6) : les modifications faites sur l'appareil que le
	 * serveur a refusées, avec ce qui avait été saisi et le motif. Lues dans la base de l'appareil, pour l'organisation
	 * active seulement ; aucun appel réseau. Cartes sur téléphone et tablette, tableau sur ordinateur.
	 */
	import { onMount } from 'svelte';
	import { formatDate } from '@ziga/shared/dates';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { messageOf } from '#lib/auth/forms.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { rejectedFields, type RejectionRow } from '#lib/sync/rejections.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';

	const t = fr.rejections;
	let rows = $state<RejectionRow[]>([]);
	let message = $state<string | null>(null);

	const time = (iso: string) =>
		new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Ouagadougou' }).format(new Date(iso));
	const what = (r: RejectionRow) => t.tables[r.table_name] ?? r.table_name;
	const fields = (r: RejectionRow) =>
		rejectedFields(r).map((f) => ({ label: t.columns[f.column] ?? f.column, value: f.value || t.emptyValue }));

	onMount(() => {
		// La notification renvoie ici : vue, elle peut se fermer.
		sync.dismissNotice();
		return sync.watch<RejectionRow>(
			LOCAL_QUERIES.rejections,
			[organizations.activeId],
			(r) => (rows = r),
			(error) => (message = messageOf(error))
		);
	});
</script>

<PageHeader title={t.title} subtitle={t.subtitle} />
<main class="page space-y-4 pt-3 pb-10">
	<FormAlert {message} />
	{#if !rows.length}
		<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground" data-testid="refus-vide">{t.empty}</p>
	{:else if device.isDesktop}
		<div class="overflow-x-auto rounded-xl border bg-card">
			<table class="w-full text-left text-base" data-testid="refus-liste">
				<thead class="border-b text-muted-foreground">
					<tr>
						<th class="px-4 py-3 font-medium">{t.when}</th>
						<th class="px-4 py-3 font-medium">{t.what}</th>
						<th class="px-4 py-3 font-medium">{t.entered}</th>
						<th class="px-4 py-3 font-medium">{t.reason}</th>
					</tr>
				</thead>
				<tbody class="divide-y">
					{#each rows as r (r.id)}
						<tr class="align-top" data-testid="refus" data-code={r.code}>
							<td class="px-4 py-3 whitespace-nowrap tabular-nums">{formatDate(r.rejected_at)} {time(r.rejected_at)}</td>
							<td class="px-4 py-3 font-medium">{what(r)}</td>
							<td class="px-4 py-3 break-words">
								{#each fields(r) as f (f.label)}<span class="block"><span class="font-medium">{f.label} :</span> {f.value}</span>{/each}
							</td>
							<td class="px-4 py-3 break-words">{r.message}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<ul class="space-y-3" data-testid="refus-liste">
			{#each rows as r (r.id)}
				<li class="space-y-2 rounded-xl border bg-card p-4" data-testid="refus" data-code={r.code}>
					<p class="font-semibold">{what(r)}</p>
					<p class="text-sm text-muted-foreground">{t.at(formatDate(r.rejected_at), time(r.rejected_at))}</p>
					{#each fields(r) as f (f.label)}
						<p class="text-base break-words"><span class="font-medium">{f.label} :</span> {f.value}</p>
					{/each}
					<p class="text-base break-words"><span class="font-medium">{t.reason} :</span> {r.message}</p>
				</li>
			{/each}
		</ul>
	{/if}
</main>
