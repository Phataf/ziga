<script lang="ts">
	/**
	 * Invitation reçue par WhatsApp (lot 03) : l'organisation, le rôle proposé et le numéro (masqué) ; acceptation
	 * par la personne connectée avec ce numéro. Sans session : connexion ou inscription, puis retour ici.
	 */
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { Building2, CheckCircle2, House } from '@lucide/svelte';
	import { formatDate } from '@ziga/shared/dates';
	import { ROLE_LABELS, type InvitationPreview, type MembershipView } from '@ziga/shared/organizations';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { auth } from '#lib/auth/auth.svelte.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { call } from '#lib/auth/http.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';

	const t = fr.invitation;
	const token = $derived(page.params.token ?? '');
	let preview = $state<InvitationPreview | null>(null);
	let message = $state<string | null>(null);
	let signedIn = $state(false);
	let busy = $state(false);
	const back = $derived(`/invitation/${token}`);

	onMount(async () => {
		try {
			preview = await call<InvitationPreview>('GET', `/invitations/${encodeURIComponent(token)}`);
		} catch (error) {
			message = messageOf(error);
		}
		signedIn = (await auth.ensure()) === 'signed_in';
	});

	async function accept() {
		message = null;
		busy = true;
		try {
			const membership = await auth.request<MembershipView>('POST', `/invitations/${encodeURIComponent(token)}/accept`);
			organizations.add(membership);
			await goto(resolve('app'), { replaceState: true });
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>{fr.app.pageTitle(t.title)}</title></svelte:head>

<div class="space-y-5" data-testid="invitation">
	<h1 class="text-2xl font-bold">{t.title}</h1>
	<FormAlert {message} />
	{#if preview}
		<div class="space-y-2 rounded-xl border bg-background p-4">
			<p class="flex items-center gap-2 text-lg font-semibold">
				{#if preview.organizationType === 'landlord'}<House class="size-5" aria-hidden="true" />{:else}<Building2
						class="size-5"
						aria-hidden="true"
					/>{/if}
				{preview.organizationName}
			</p>
			<p class="text-base">{t.role(ROLE_LABELS[preview.role])}</p>
			<p class="text-base text-muted-foreground">{t.from(preview.invitedBy)}</p>
			<p class="text-base text-muted-foreground tabular-nums">{t.phone(preview.phone)}</p>
			<p class="text-base text-muted-foreground">{t.expires(formatDate(preview.expiresAt))}</p>
		</div>
		{#if signedIn}
			<Button size="lg" class="w-full" onclick={accept} disabled={busy}
				><CheckCircle2 aria-hidden="true" />{busy ? fr.auth.submitting : t.accept}</Button
			>
		{:else}
			<p class="text-base">{t.loginFirst}</p>
			<Button href={`${resolve('connexion')}?retour=${encodeURIComponent(back)}`} size="lg" class="w-full">{t.login}</Button>
			<Button href={`${resolve('inscription')}?retour=${encodeURIComponent(back)}`} variant="outline" class="w-full">{t.register}</Button>
		{/if}
	{/if}
</div>
