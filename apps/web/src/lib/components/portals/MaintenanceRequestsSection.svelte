<script lang="ts">
	/**
	 * Signalements du locataire sur la fiche du bail (lot 10 ter, réponse 4 du porteur) : lus sur l'appareil (table
	 * synchronisée, sans la personne qui signale) ; planifier (date de passage, mot pour le locataire) et marquer fait :
	 * direction et gestion, en ligne.
	 */
	import { onMount } from 'svelte';
	import { CalendarClock, CheckCheck, Wrench } from '@lucide/svelte';
	import { formatDate, toIsoDate } from '@ziga/shared/dates';
	import { can } from '@ziga/shared/permissions';
	import { updateMaintenanceRequestSchema } from '@ziga/shared/person-links';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import Sheet from '#lib/components/ui/sheet/Sheet.svelte';
	import { messageOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { toMaintenanceRequest, type LocalMaintenanceRequest } from '#lib/portals/links.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';

	let { leaseId }: { leaseId: string } = $props();
	const t = fr.maintenance;
	const canManage = $derived(can(organizations.active?.role, 'maintenance_request.manage'));
	let requests = $state<LocalMaintenanceRequest[]>([]);
	let target = $state<LocalMaintenanceRequest | null>(null);
	let mode = $state<'planned' | 'done'>('planned');
	let open = $state(false);
	let plannedOn = $state(toIsoDate());
	let note = $state('');
	let busy = $state(false);
	let message = $state<string | null>(null);
	let saved = $state<string | null>(null);

	onMount(() =>
		sync.watch<Record<string, unknown>>(
			LOCAL_QUERIES.leaseMaintenanceRequests,
			[organizations.activeId, leaseId],
			(rows) => (requests = rows.map(toMaintenanceRequest))
		)
	);

	function start(r: LocalMaintenanceRequest, next: 'planned' | 'done') {
		target = r;
		mode = next;
		note = r.statusNote ?? '';
		plannedOn = r.plannedOn ?? toIsoDate();
		message = saved = null;
		open = true;
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		const parsed = updateMaintenanceRequestSchema.safeParse({
			status: mode,
			plannedOn: mode === 'planned' ? plannedOn : null,
			statusNote: note
		});
		if (!parsed.success) {
			message = parsed.error.issues[0]?.message ?? null;
			return;
		}
		busy = true;
		try {
			await organizations.call('PATCH', `/maintenance-requests/${target!.id}`, parsed.data);
			open = false;
			saved = t.saved;
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}

	const tone = (s: LocalMaintenanceRequest['status']) => (s === 'done' ? 'success' : s === 'planned' ? 'info' : 'warning');
</script>

<section class="space-y-3 rounded-xl border bg-card p-4" aria-labelledby="titre-signalements" data-testid="signalements">
	<h2 id="titre-signalements" class="flex items-center gap-2 text-lg font-semibold">
		<Wrench class="size-5" aria-hidden="true" />{t.title}
	</h2>
	{#if saved}<p role="status" class="text-base font-medium">{saved}</p>{/if}
	{#each requests as r (r.id)}
		<article class="space-y-2 rounded-lg border p-3" data-testid="signalement" data-statut={r.status}>
			<p class="flex flex-wrap items-center gap-2">
				<span class="font-semibold break-words">{r.title}</span><Badge variant={tone(r.status)}>{t.statuses[r.status]}</Badge>
			</p>
			<p class="text-base break-words">{r.description}</p>
			<p class="text-sm text-muted-foreground">
				{t.reportedOn(formatDate(r.createdAt.slice(0, 10)))}{#if r.plannedOn}&nbsp;· {t.plannedOn(formatDate(r.plannedOn))}{/if}
			</p>
			{#if r.statusNote}<p class="text-base break-words text-muted-foreground">{r.statusNote}</p>{/if}
			{#if canManage && r.status !== 'done'}
				<div class="flex flex-wrap gap-2">
					{#if r.status === 'received'}
						<Button variant="outline" onclick={() => start(r, 'planned')} disabled={!sync.online} data-testid="planifier-signalement">
							<CalendarClock class="size-5" aria-hidden="true" />{t.plan}
						</Button>
					{/if}
					<Button variant="outline" onclick={() => start(r, 'done')} disabled={!sync.online} data-testid="signalement-fait">
						<CheckCheck class="size-5" aria-hidden="true" />{t.done}
					</Button>
				</div>
			{/if}
		</article>
	{:else}
		<p class="text-base text-muted-foreground">{t.none}</p>
	{/each}
</section>

<Sheet bind:open labelledby="signalement-titre" side="right">
	<form class="space-y-4" onsubmit={submit} novalidate data-testid="formulaire-signalement">
		<h2 id="signalement-titre" class="pr-10 text-xl font-semibold">{mode === 'planned' ? t.planTitle : t.doneTitle}</h2>
		<FormAlert {message} />
		{#if mode === 'planned'}
			<label class="block space-y-1">
				<span class="text-base font-medium">{t.date}</span>
				<Input type="date" bind:value={plannedOn} data-testid="date-passage" />
			</label>
		{/if}
		<label class="block space-y-1">
			<span class="text-base font-medium">{t.note}</span>
			<Input bind:value={note} data-testid="mot-signalement" />
		</label>
		<Button type="submit" class="w-full" disabled={busy} data-testid="enregistrer-signalement">{t.save}</Button>
	</form>
</Sheet>
