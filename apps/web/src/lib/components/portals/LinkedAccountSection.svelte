<script lang="ts">
	/**
	 * Section « Compte lié » d'une fiche propriétaire ou locataire (lot 10 ter, étape 3), direction et gestion seulement :
	 * inviter la personne (WhatsApp ou SMS au numéro de la fiche), renvoyer une invitation perdue ou expirée (l'ancienne
	 * révoquée, une nouvelle envoyée, en une action), accepter une demande, révoquer. En ligne seulement ; l'état se calcule
	 * par une règle pure (`lib/portals/links.ts`).
	 */
	import { onMount } from 'svelte';
	import { Link2, MessageCircle, MessageSquareText, Unlink } from '@lucide/svelte';
	import { formatDate } from '@ziga/shared/dates';
	import { newId } from '@ziga/shared/ids';
	import { can } from '@ziga/shared/permissions';
	import { revokePersonLinkSchema, type PersonLinkRecordType, type PersonLinkView } from '@ziga/shared/person-links';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import Sheet from '#lib/components/ui/sheet/Sheet.svelte';
	import { messageOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { whatsappLink } from '#lib/payments/views.ts';
	import { linkState } from '#lib/portals/links.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';

	let { recordType, recordId, phone }: { recordType: PersonLinkRecordType; recordId: string; phone: string | null } = $props();

	const t = fr.personLinks;
	const allowed = $derived(can(organizations.active?.role, 'person_link.manage'));
	let links = $state<PersonLinkView[]>([]);
	let loaded = $state(false);
	let busy = $state(false);
	let message = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let whatsapp = $state<string | null>(null);
	let revokeOpen = $state(false);
	let reason = $state('');
	let reasonError = $state<string | null>(null);
	const current = $derived(linkState(links));

	async function load() {
		if (!sync.online) return;
		try {
			links = await organizations.call<PersonLinkView[]>('GET', `/person-links?recordType=${recordType}&recordId=${recordId}`);
			loaded = true;
		} catch (error) {
			message = messageOf(error);
		}
	}

	onMount(() => {
		if (allowed) void load();
	});

	async function send(channel: 'whatsapp' | 'sms') {
		message = notice = whatsapp = null;
		busy = true;
		try {
			const body = { sendSms: channel === 'sms' };
			const r = current.canResend
				? await organizations.call<{ url: string }>('POST', `/person-links/${current.link!.id}/resend`, body)
				: await organizations.call<{ url: string }>('POST', '/person-links', { id: newId(), recordType, recordId, ...body });
			if (channel === 'whatsapp') {
				whatsapp = whatsappLink(phone, t.whatsappText(organizations.active?.name ?? '', r.url));
				notice = t.ready;
			} else notice = t.sent;
			await load();
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}

	async function accept() {
		message = notice = null;
		busy = true;
		try {
			await organizations.call('POST', `/person-links/${current.link!.id}/accept`);
			notice = t.accepted;
			await load();
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}

	async function revoke(event: SubmitEvent) {
		event.preventDefault();
		const parsed = revokePersonLinkSchema.safeParse({ reason });
		reasonError = parsed.success ? null : (parsed.error.issues[0]?.message ?? null);
		if (!parsed.success) return;
		busy = true;
		try {
			await organizations.call('POST', `/person-links/${current.link!.id}/revoke`, parsed.data);
			revokeOpen = false;
			reason = '';
			notice = t.revoked;
			whatsapp = null;
			await load();
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}

	const stateText = $derived(
		current.kind === 'invited' ? t.states.invited(formatDate(current.link!.inviteExpiresAt!.slice(0, 10))) : t.states[current.kind]
	);
</script>

{#if allowed}
	<section class="space-y-3 rounded-xl border bg-card p-4" aria-labelledby="titre-compte-lie" data-testid="compte-lie">
		<h2 id="titre-compte-lie" class="flex items-center gap-2 text-lg font-semibold">
			<Link2 class="size-5" aria-hidden="true" />{t.title}
		</h2>
		<p class="text-base text-muted-foreground">{t.intro[recordType]}</p>
		<FormAlert {message} />
		{#if notice}<p role="status" class="text-base font-medium" data-testid="compte-lie-message">{notice}</p>{/if}
		{#if !sync.online}
			<p class="text-base text-muted-foreground">{t.online}</p>
		{:else if loaded}
			<p class="text-base break-words" data-testid="compte-lie-etat">
				<Badge variant={current.kind === 'active' ? 'success' : current.kind === 'none' ? 'default' : 'info'}>{t.title}</Badge>
				{stateText}
			</p>
			{#if (current.canInvite || current.canResend) && !phone}
				<p class="text-base text-muted-foreground" data-testid="compte-lie-sans-numero">{t.noPhone}</p>
			{:else if current.canInvite || current.canResend}
				<div class="flex flex-wrap gap-2">
					<Button onclick={() => send('whatsapp')} disabled={busy} data-testid={current.canResend ? 'renvoyer-whatsapp' : 'inviter-whatsapp'}>
						<MessageCircle class="size-5" aria-hidden="true" />{current.canResend ? t.resendWhatsapp : t.inviteWhatsapp}
					</Button>
					<Button
						variant="outline"
						onclick={() => send('sms')}
						disabled={busy}
						data-testid={current.canResend ? 'renvoyer-sms' : 'inviter-sms'}
					>
						<MessageSquareText class="size-5" aria-hidden="true" />{current.canResend ? t.resendSms : t.inviteSms}
					</Button>
				</div>
			{/if}
			{#if whatsapp}
				<Button variant="outline" href={whatsapp} target="_blank" rel="noopener" data-testid="ouvrir-whatsapp">
					<MessageCircle class="size-5" aria-hidden="true" />{t.openWhatsapp}
				</Button>
			{/if}
			{#if current.canAccept}
				<Button onclick={accept} disabled={busy} data-testid="accepter-liaison">{t.accept}</Button>
			{/if}
			{#if current.canRevoke}
				<Button variant="outline" onclick={() => (revokeOpen = true)} disabled={busy} data-testid="revoquer-liaison">
					<Unlink class="size-5" aria-hidden="true" />{t.revoke}
				</Button>
			{/if}
		{/if}
	</section>

	<Sheet bind:open={revokeOpen} labelledby="revoquer-titre" side="right">
		<form class="space-y-4" onsubmit={revoke} novalidate data-testid="formulaire-revocation">
			<h2 id="revoquer-titre" class="pr-10 text-xl font-semibold">{t.revokeTitle}</h2>
			<p class="text-base text-muted-foreground">{t.revokeHelp}</p>
			<label class="block space-y-1">
				<span class="text-base font-medium">{t.reason}</span>
				<Input bind:value={reason} aria-invalid={!!reasonError} data-testid="motif-revocation" />
			</label>
			{#if reasonError}<p class="text-base text-destructive">{reasonError}</p>{/if}
			<Button type="submit" disabled={busy} class="w-full" data-testid="confirmer-revocation">{t.revokeConfirm}</Button>
		</form>
	</Sheet>
{/if}
