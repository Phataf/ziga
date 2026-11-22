<script lang="ts">
	/**
	 * Demande de préavis (lot 10 ter, étape 3c) : sur un bail en vigueur, la date de sortie souhaitée et le motif ; une
	 * demande à traiter par l'organisation, jamais un congé enregistré (le congé, sa date et sa preuve sont saisis par
	 * l'organisation, lot 10 bis). Les refus du serveur (date passée, demande déjà en cours) sont affichés tels quels.
	 */
	import { onMount } from 'svelte';
	import { addDays, toIsoDate } from '@ziga/shared/dates';
	import { portalNoticeRequestSchema } from '@ziga/shared/portals';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import RemoteState from '#lib/components/portals/RemoteState.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { auth } from '#lib/auth/auth.svelte.ts';
	import { fieldErrors, messageOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { Remote } from '#lib/portals/remote.svelte.ts';
	import { noticeCandidates, placeLabel, type TenantHome } from '#lib/portals/tenant.ts';

	const t = fr.tenantSpace;
	const home = new Remote<{ homes: TenantHome[] }>('/me/portal/tenant/home');
	onMount(() => void home.load());
	const candidates = $derived(noticeCandidates(home.data?.homes ?? []));

	let lease = $state('');
	let plannedExitOn = $state(addDays(toIsoDate(), 90));
	let reason = $state('');
	let errors = $state<Record<string, string>>({});
	let message = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let busy = $state(false);
	$effect(() => {
		if (!lease && candidates[0]) lease = `${candidates[0].organizationId}|${candidates[0].leaseId}`;
	});

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		const [organizationId, leaseId] = lease.split('|');
		const parsed = portalNoticeRequestSchema.safeParse({ organizationId, leaseId, plannedExitOn, reason });
		errors = fieldErrors(parsed.error);
		if (!parsed.success) return;
		busy = true;
		message = notice = null;
		try {
			await auth.request('POST', '/me/portal/tenant/notice-requests', parsed.data);
			notice = t.noticeSent;
			reason = '';
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}
</script>

<PageHeader title={t.noticeTitle} subtitle={t.noticeSubtitle} />

<main class="page-narrow space-y-4 pt-3 pb-10" data-testid="preavis-locataire">
	<p class="text-base text-muted-foreground">{t.noticeNotRecorded}</p>
	<RemoteState remote={home}>
		{#if !candidates.length}
			<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground" data-testid="preavis-impossible">{t.noLeaseForNotice}</p>
		{:else}
			<form class="space-y-4 rounded-xl border bg-card p-4 md:p-6" onsubmit={submit} novalidate data-testid="formulaire-preavis">
				<FormAlert {message} />
				{#if notice}<p role="status" class="text-base font-medium" data-testid="preavis-message">{notice}</p>{/if}
				<label class="block space-y-1">
					<span class="text-base font-medium">{t.housing}</span>
					<select
						bind:value={lease}
						class="min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 text-base"
						data-testid="preavis-logement"
					>
						{#each candidates as h (h.organizationId + h.leaseId)}
							<option value="{h.organizationId}|{h.leaseId}">{placeLabel(h)} ({h.organizationName})</option>
						{/each}
					</select>
				</label>
				<label class="block space-y-1">
					<span class="text-base font-medium">{t.plannedExitOn}</span>
					<Input
						type="date"
						bind:value={plannedExitOn}
						min={toIsoDate()}
						aria-invalid={!!errors.plannedExitOn}
						data-testid="preavis-date"
					/>
				</label>
				{#if errors.plannedExitOn}<p class="text-base text-destructive">{errors.plannedExitOn}</p>{/if}
				<label class="block space-y-1">
					<span class="text-base font-medium">{t.reason}</span>
					<textarea
						bind:value={reason}
						rows="4"
						aria-invalid={!!errors.reason}
						class="w-full rounded-lg border-2 border-input bg-card px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30"
						data-testid="preavis-motif"></textarea>
				</label>
				{#if errors.reason}<p class="text-base text-destructive">{errors.reason}</p>{/if}
				<Button type="submit" disabled={busy} class="w-full sm:w-auto" data-testid="envoyer-preavis">{t.sendNotice}</Button>
			</form>
		{/if}
	</RemoteState>
</main>
