<script lang="ts">
	/**
	 * Invitation à lier une fiche (lot 10 ter, étape 3d), reçue par WhatsApp ou SMS : l'organisation, le type de fiche, le
	 * numéro masqué. Sans session : connexion ou inscription, puis retour ici. Connectée avec ce numéro : la personne
	 * réclame l'invitation, le code part au numéro de la fiche, elle le saisit ; le lien devient actif.
	 */
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { Link2 } from '@lucide/svelte';
	import { formatDate } from '@ziga/shared/dates';
	import { verifyPersonLinkSchema, type MyPersonLinkView, type PersonLinkInvitationPreview } from '@ziga/shared/person-links';
	import CodeField from '#lib/components/auth/CodeField.svelte';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { auth } from '#lib/auth/auth.svelte.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { call } from '#lib/auth/http.ts';
	import { fr } from '#lib/i18n/fr.ts';

	const t = fr.myLinks;
	const token = $derived(page.params.token ?? '');
	const back = $derived(`/lier/${token}`);
	let preview = $state<PersonLinkInvitationPreview | null>(null);
	let signedIn = $state(false);
	let claimed = $state<{ organizationId: string; linkId: string } | null>(null);
	let code = $state('');
	let codeError = $state<string | undefined>();
	let message = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let done = $state<MyPersonLinkView | null>(null);
	let busy = $state(false);

	onMount(async () => {
		try {
			preview = await call<PersonLinkInvitationPreview>('GET', `/person-link-invitations/${encodeURIComponent(token)}`);
		} catch (error) {
			message = messageOf(error);
		}
		signedIn = (await auth.ensure()) === 'signed_in';
	});

	async function claim() {
		message = null;
		busy = true;
		try {
			claimed = await auth.request<{ organizationId: string; linkId: string }>(
				'POST',
				`/person-link-invitations/${encodeURIComponent(token)}/claim`
			);
			notice = t.codeSent;
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}

	async function verify(event: SubmitEvent) {
		event.preventDefault();
		if (!claimed) return;
		const parsed = verifyPersonLinkSchema.safeParse({ organizationId: claimed.organizationId, code });
		codeError = parsed.success ? undefined : parsed.error.issues[0]?.message;
		if (!parsed.success) return;
		busy = true;
		message = null;
		try {
			done = await auth.request<MyPersonLinkView>('POST', `/me/person-links/${claimed.linkId}/verify`, parsed.data);
		} catch (error) {
			codeError = messageOf(error);
		} finally {
			busy = false;
		}
	}

	async function resend() {
		if (!claimed) return;
		message = null;
		try {
			await auth.request('POST', `/me/person-links/${claimed.linkId}/code`, { organizationId: claimed.organizationId });
			notice = t.codeSent;
		} catch (error) {
			message = messageOf(error);
		}
	}
</script>

<svelte:head><title>{fr.app.pageTitle(t.inviteTitle)}</title></svelte:head>

<div class="space-y-5" data-testid="lier">
	<h1 class="text-2xl font-bold">{t.inviteTitle}</h1>
	<FormAlert {message} />
	{#if preview}
		<div class="space-y-2 rounded-xl border bg-background p-4">
			<p class="flex items-start gap-2 text-lg font-semibold break-words">
				<Link2 class="mt-1 size-5 shrink-0" aria-hidden="true" />{t.invites(preview.organizationName)}
			</p>
			<p class="text-base">{t.as[preview.recordType]}</p>
			<p class="text-base text-muted-foreground tabular-nums">{t.phone(preview.phone)}</p>
			<p class="text-base text-muted-foreground">{t.expires(formatDate(preview.expiresAt.slice(0, 10)))}</p>
		</div>
		{#if done}
			<p role="status" class="text-base font-medium" data-testid="lier-fait">{done.status === 'active' ? t.linked : t.awaiting}</p>
			<Button
				href={resolve(done.recordType === 'owner' ? '/espace/proprietaire' : '/espace/locataire')}
				size="lg"
				class="w-full"
				data-testid="lier-ouvrir">{t.openSpace[done.recordType]}</Button
			>
		{:else if !preview.usable && !claimed}
			<p class="text-base" data-testid="lier-invalide">{t.unusable}</p>
		{:else if !signedIn}
			<p class="text-base">{t.loginFirst}</p>
			<Button href={`${resolve('connexion')}?retour=${encodeURIComponent(back)}`} size="lg" class="w-full" data-testid="lier-connexion"
				>{t.login}</Button
			>
			<Button href={`${resolve('inscription')}?retour=${encodeURIComponent(back)}`} variant="outline" class="w-full">{t.register}</Button>
		{:else if !claimed}
			<Button size="lg" class="w-full" onclick={claim} disabled={busy} data-testid="lier-reclamer">{t.claim}</Button>
		{:else}
			{#if notice}<p role="status" class="text-base">{notice}</p>{/if}
			<form class="space-y-4" onsubmit={verify} novalidate>
				<CodeField bind:value={code} error={codeError} id="code-liaison" />
				<Button type="submit" size="lg" class="w-full" disabled={busy} data-testid="lier-valider">{t.verify}</Button>
			</form>
			<Button variant="outline" class="w-full" onclick={resend} disabled={busy}>{t.resend}</Button>
		{/if}
	{/if}
</div>
