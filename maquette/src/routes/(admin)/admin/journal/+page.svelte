<script lang="ts">
	/** Journal du back-office, en ajout seul : qui, quelle organisation, quoi, avant, après. */
	import { Globe } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { demo } from '$lib/demo.svelte';
	import { device } from '$lib/device.svelte';
	import { cn } from '$lib/utils';

	const when = (iso: string) =>
		new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Ouagadougou' });
</script>

<PageHeader title="Journal" subtitle="Ajout seul : aucune ligne n’est modifiée ni supprimée" />

<main class="page pt-3" data-testid="admin-journal">
	{#if device.isPhone}
		<ul class="space-y-2">
			{#each demo.audit as a (a.id)}
				<li class={cn('space-y-1 rounded-xl border bg-card p-3', a.global && 'border-destructive bg-danger-soft')}>
					<p class="text-base text-muted-foreground">{when(a.at)} · {a.actor}</p>
					<p class="font-medium">{a.action}</p>
					<p class="text-base">{a.organization}{a.before ? ` · ${a.before} → ${a.after}` : ''}</p>
				</li>
			{/each}
		</ul>
	{:else}
		<div class="overflow-x-auto rounded-xl border bg-card">
			<table class="data">
				<thead><tr><th>Date</th><th>Acteur</th><th>Organisation</th><th>Action</th><th>Avant</th><th>Après</th></tr></thead>
				<tbody>
					{#each demo.audit as a (a.id)}
						<tr class={cn(a.global && 'bg-danger-soft')} data-testid="ligne-journal">
							<td class="whitespace-nowrap tabular-nums">{when(a.at)}</td>
							<td>{a.actor}</td>
							<td>{#if a.global}<span class="flex items-center gap-1 font-semibold text-destructive"><Globe class="size-4" aria-hidden="true" />{a.organization}</span>{:else}{a.organization}{/if}</td>
							<td>{a.action}</td>
							<td>{a.before ?? '—'}</td>
							<td>{a.after ?? '—'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</main>
