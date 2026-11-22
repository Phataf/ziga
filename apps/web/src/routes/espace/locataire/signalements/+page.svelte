<script lang="ts">
	/**
	 * Signalements (lot 10 ter, étape 3c) : le locataire signale un problème sur l'un de ses baux en cours ; c'est une
	 * demande à traiter par l'organisation (reçu, planifié, fait), jamais une écriture au registre. Débit limité par le
	 * serveur ; le message d'erreur du serveur est affiché tel quel.
	 */
	import { onMount } from 'svelte';
	import { Plus } from '@lucide/svelte';
	import { formatDate } from '@ziga/shared/dates';
	import { newId } from '@ziga/shared/ids';
	import { portalMaintenanceRequestSchema } from '@ziga/shared/portals';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import RemoteState from '#lib/components/portals/RemoteState.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import Sheet from '#lib/components/ui/sheet/Sheet.svelte';
	import { auth } from '#lib/auth/auth.svelte.ts';
	import { fieldErrors, messageOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { Remote } from '#lib/portals/remote.svelte.ts';
	import { placeLabel, sortRequests, type TenantHome, type TenantRequest } from '#lib/portals/tenant.ts';

	const t = fr.tenantSpace;
	const statuses = fr.maintenance.statuses;
	const requests = new Remote<TenantRequest[]>('/me/portal/tenant/requests');
	const home = new Remote<{ homes: TenantHome[] }>('/me/portal/tenant/home');
	onMount(() => void Promise.all([requests.load(), home.load()]));
	const rows = $derived(sortRequests(requests.data ?? []));
	const homes = $derived(home.data?.homes ?? []);

	let open = $state(false);
	let lease = $state('');
	let title = $state('');
	let description = $state('');
	let errors = $state<Record<string, string>>({});
	let message = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let busy = $state(false);

	function start() {
		lease = homes[0] ? `${homes[0].organizationId}|${homes[0].leaseId}` : '';
		title = description = '';
		errors = {};
		message = null;
		open = true;
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		const [organizationId, leaseId] = lease.split('|');
		const parsed = portalMaintenanceRequestSchema.safeParse({ id: newId(), organizationId, leaseId, title, description });
		errors = fieldErrors(parsed.error);
		if (!parsed.success) return;
		busy = true;
		message = null;
		try {
			await auth.request('POST', '/me/portal/tenant/requests', parsed.data);
			open = false;
			notice = t.requestSent;
			await requests.load();
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}
</script>

<PageHeader title={t.requestsTitle} subtitle={t.requestsSubtitle} />

<main class="page space-y-4 pt-3 pb-10" data-testid="signalements-locataire">
	{#if notice}<p role="status" class="text-base font-medium" data-testid="signalement-message">{notice}</p>{/if}
	{#if home.data && !homes.length}
		<p class="text-base text-muted-foreground">{t.noLeaseForRequest}</p>
	{:else}
		<Button onclick={start} disabled={!homes.length} data-testid="nouveau-signalement">
			<Plus class="size-5" aria-hidden="true" />{t.newRequest}
		</Button>
	{/if}
	<RemoteState remote={requests}>
		{#if !rows.length}
			<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground" data-testid="signalements-vide">{t.noRequest}</p>
		{:else}
			<ul class="grid gap-3 lg:grid-cols-2">
				{#each rows as r (r.organizationId + r.id)}
					<li class="space-y-2 rounded-xl border bg-card p-4" data-testid="signalement-locataire" data-statut={r.status}>
						<div class="flex flex-wrap items-center justify-between gap-2">
							<span class="font-semibold break-words">{r.title}</span>
							<Badge variant={r.status === 'done' ? 'success' : r.status === 'planned' ? 'info' : 'secondary'}>{statuses[r.status]}</Badge>
						</div>
						<p class="text-base break-words whitespace-pre-line">{r.description}</p>
						<p class="text-base text-muted-foreground">
							{r.organizationName}&nbsp;· {t.reportedOn(formatDate(r.createdAt.slice(0, 10)))}
						</p>
						{#if r.status === 'planned' && r.plannedOn}<p class="text-base font-medium">{t.plannedOn(formatDate(r.plannedOn))}</p>{/if}
						{#if r.status === 'done' && r.doneAt}<p class="text-base font-medium">{t.doneOn(formatDate(r.doneAt.slice(0, 10)))}</p>{/if}
						{#if r.statusNote}
							<p class="rounded-lg bg-muted p-3 text-base break-words">
								<span class="font-medium">{t.organizationNote} :</span>
								{r.statusNote}
							</p>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</RemoteState>
</main>

<Sheet bind:open labelledby="signalement-titre" side="right">
	<form class="space-y-4" onsubmit={submit} novalidate data-testid="formulaire-signalement">
		<h2 id="signalement-titre" class="pr-10 text-xl font-semibold">{t.newRequest}</h2>
		<FormAlert {message} />
		<label class="block space-y-1">
			<span class="text-base font-medium">{t.housing}</span>
			<select
				bind:value={lease}
				class="min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 text-base"
				data-testid="signalement-logement"
			>
				{#each homes as h (h.organizationId + h.leaseId)}
					<option value="{h.organizationId}|{h.leaseId}">{placeLabel(h)} ({h.organizationName})</option>
				{/each}
			</select>
		</label>
		<label class="block space-y-1">
			<span class="text-base font-medium">{t.title}</span>
			<Input bind:value={title} aria-invalid={!!errors.title} data-testid="signalement-objet" />
		</label>
		{#if errors.title}<p class="text-base text-destructive">{errors.title}</p>{/if}
		<label class="block space-y-1">
			<span class="text-base font-medium">{t.description}</span>
			<textarea
				bind:value={description}
				rows="5"
				aria-invalid={!!errors.description}
				class="w-full rounded-lg border-2 border-input bg-card px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30"
				data-testid="signalement-description"></textarea>
		</label>
		{#if errors.description}<p class="text-base text-destructive">{errors.description}</p>{/if}
		<Button type="submit" disabled={busy} class="w-full" data-testid="envoyer-signalement">{t.submit}</Button>
	</form>
</Sheet>
