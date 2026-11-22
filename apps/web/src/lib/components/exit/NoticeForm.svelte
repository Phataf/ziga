<script lang="ts">
	/**
	 * Congé (lot 10 bis, bouton « Préavis » de la fiche bail) : origine, mode de notification et preuve, dates. L'écran
	 * montre le délai, la fin du loyer et l'éventuelle indemnité calculés par la même fonction que le serveur (D24, D32),
	 * et refuse ce que le serveur refuserait. Enregistré en ligne (`lease.notice`) : le bail passe en préavis.
	 */
	import { formatDate, toIsoDate } from '@ziga/shared/dates';
	import { recordNoticeSchema } from '@ziga/shared/exit-schemas';
	import { newId } from '@ziga/shared/ids';
	import type { LeaseView } from '@ziga/shared/leases';
	import { formatFcfa } from '@ziga/shared/money';
	import { NOTICE_DELIVERY_MODES, noticeBlocker, noticeTerms, type NoticeOrigin } from '@ziga/shared/tenant-exit';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import ReceiptPicker from '#lib/components/collections/ReceiptPicker.svelte';
	import DocumentVisibilityNotice from '#lib/components/portals/DocumentVisibilityNotice.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import Sheet from '#lib/components/ui/sheet/Sheet.svelte';
	import { messageOf } from '#lib/auth/forms.ts';
	import { uploadExitDocument } from '#lib/exit/documents.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';

	let { open = $bindable(false), lease, onrecorded }: { open: boolean; lease: LeaseView; onrecorded?: () => void } = $props();
	const t = fr.exit.notice;
	const today = toIsoDate();

	let origin = $state<NoticeOrigin>('tenant');
	let deliveryMode = $state<(typeof NOTICE_DELIVERY_MODES)[number]>('hand_delivery');
	let notifiedOn = $state(today);
	let plannedExitOn = $state(today);
	let reduced = $state(false);
	let reason = $state('');
	let files = $state<File[]>([]);
	let message = $state<string | null>(null);
	let busy = $state(false);

	const input = $derived({ origin, notifiedOn, plannedExitOn, reducedNotice: reduced, today });
	const blocker = $derived(noticeBlocker(lease, input));
	const terms = $derived(blocker === null || blocker === 'NOTICE_LESSOR_TOO_SHORT' ? noticeTerms(lease, input) : null);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		message = null;
		if (blocker) return void (message = t.blockers[blocker] ?? null);
		busy = true;
		try {
			const proofDocumentId = files.length
				? await uploadExitDocument('notice_proof', { leaseId: lease.id }, files, 'Preuve du congé')
				: null;
			const parsed = recordNoticeSchema.safeParse({
				id: newId(),
				origin,
				deliveryMode,
				proofDocumentId,
				notifiedOn,
				plannedExitOn,
				reducedNotice: reduced,
				reason
			});
			if (!parsed.success) return void (message = parsed.error.issues[0]!.message);
			await organizations.call('POST', `/leases/${lease.id}/notice`, parsed.data);
			open = false;
			onrecorded?.();
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}

	const field = 'space-y-1';
	const select = 'min-h-11 w-full rounded-lg border bg-background px-3 text-base';
</script>

<Sheet bind:open labelledby="conge-titre" side="right">
	<form class="space-y-4" onsubmit={submit} novalidate data-testid="formulaire-conge">
		<h2 id="conge-titre" class="pr-10 text-xl font-semibold">{t.title}</h2>
		<FormAlert {message} />
		<fieldset class="space-y-2">
			<legend class="text-base font-medium">{t.origin}</legend>
			{#each ['tenant', 'lessor'] as const as o (o)}
				<label class="flex min-h-11 items-center gap-3 rounded-lg border-2 bg-card px-3 py-2 has-checked:border-primary">
					<input type="radio" name="origine" value={o} bind:group={origin} class="size-5 shrink-0" />{t.origins[o]}
				</label>
			{/each}
		</fieldset>
		<div class={field}>
			<label for="conge-mode" class="text-base font-medium">{t.deliveryMode}</label>
			<select id="conge-mode" class={select} bind:value={deliveryMode}>
				{#each NOTICE_DELIVERY_MODES as m (m)}<option value={m}>{t.deliveryModes[m]}</option>{/each}
			</select>
		</div>
		<div class="grid gap-3 sm:grid-cols-2">
			<div class={field}>
				<label for="conge-notifie" class="text-base font-medium">{t.notifiedOn}</label>
				<Input id="conge-notifie" type="date" bind:value={notifiedOn} max={today} data-testid="conge-notifie" />
			</div>
			<div class={field}>
				<label for="conge-sortie" class="text-base font-medium">{t.plannedExitOn}</label>
				<Input id="conge-sortie" type="date" bind:value={plannedExitOn} data-testid="conge-sortie" />
			</div>
		</div>
		{#if origin === 'tenant' && lease.reducedNoticeMonths !== null}
			<label class="flex min-h-11 items-center gap-3"><input type="checkbox" class="size-5" bind:checked={reduced} />{t.reduced}</label>
		{/if}
		<div class={field}>
			<label for="conge-motif" class="text-base font-medium">{t.reason}</label>
			<Input id="conge-motif" bind:value={reason} maxlength={500} />
		</div>
		{#if terms}
			<div class="space-y-1 rounded-lg bg-muted p-3 text-base" data-testid="conge-apercu">
				<p>{t.preview(terms.months, formatDate(terms.noticeEndsOn))}</p>
				<p>{t.rentUntil(formatDate(terms.rentEndsOn))}</p>
				{#if terms.earlyTerminationIndemnity > 0}<p>{t.indemnity(formatFcfa(terms.earlyTerminationIndemnity))}</p>{/if}
				<p class="text-sm text-muted-foreground">{t.jurist}</p>
			</div>
		{/if}
		{#if blocker}<FormAlert message={t.blockers[blocker] ?? null} />{/if}
		<ReceiptPicker bind:files title={t.proof} hint={t.proofHint} testid="preuve-conge" />
		<DocumentVisibilityNotice type="notice_proof" />
		<Button type="submit" class="w-full" disabled={busy || !sync.online || !!blocker} data-testid="enregistrer-conge">{t.submit}</Button>
		{#if !sync.online}<p class="text-sm text-muted-foreground">{fr.exit.onlineOnly}</p>{/if}
	</form>
</Sheet>
