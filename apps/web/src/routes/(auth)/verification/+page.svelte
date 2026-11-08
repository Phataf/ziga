<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { otpCodeSchema } from '@ziga/shared/auth';
	import { formatPhone, isPhone } from '@ziga/shared/phone';
	import { RefreshCw, ShieldCheck } from '@lucide/svelte';
	import CodeField from '#lib/components/auth/CodeField.svelte';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { auth } from '#lib/auth/auth.svelte.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { pendingRegistration } from '#lib/auth/pending.ts';
	import { safeReturn } from '#lib/auth/outcome.ts';
	import { fr } from '#lib/i18n/fr.ts';

	const t = fr.auth;
	const phone = $derived(page.url.searchParams.get('numero') ?? '');
	const valid = $derived(isPhone(phone));
	let code = $state('');
	let error = $state<string | undefined>();
	let message = $state<string | null>(null);
	let info = $state<string | null>(page.url.searchParams.get('renvoye') ? t.verify.notVerified : null);
	let busy = $state(false);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		message = null;
		const parsed = otpCodeSchema.safeParse(code.trim());
		error = parsed.success ? undefined : parsed.error.issues[0]?.message;
		if (!parsed.success) return;
		busy = true;
		try {
			await auth.verifyPhone({ phone, code: parsed.data });
			pendingRegistration.value = null;
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- chemin interne vérifié par safeReturn()
			await goto(safeReturn(page.url.searchParams.get('retour')), { replaceState: true });
		} catch (err) {
			message = messageOf(err);
		} finally {
			busy = false;
		}
	}

	async function resend() {
		message = null;
		const pending = pendingRegistration.value;
		if (!pending || pending.phone !== phone) {
			info = t.verify.resendByLogin;
			return;
		}
		try {
			await auth.register(pending);
			info = t.verify.resent;
		} catch (err) {
			message = messageOf(err);
		}
	}
</script>

<svelte:head><title>{fr.app.pageTitle(t.verify.title)}</title></svelte:head>

{#if !valid}
	<div class="space-y-4">
		<h1 class="text-2xl font-bold">{t.verify.title}</h1>
		<FormAlert message={t.verify.missingPhone} />
		<Button href={resolve('inscription')} variant="outline" class="w-full">{fr.auth.register.title}</Button>
	</div>
{:else}
	<form class="space-y-5" onsubmit={submit} novalidate data-testid="formulaire-verification">
		<div class="space-y-1">
			<h1 class="text-2xl font-bold">{t.verify.title}</h1>
			<p class="text-base text-muted-foreground">{t.verify.subtitle(formatPhone(phone))}</p>
		</div>
		<FormAlert message={info} tone="info" />
		<FormAlert {message} />
		<CodeField bind:value={code} {error} />
		<Button type="submit" size="lg" class="w-full" disabled={busy}>
			<ShieldCheck aria-hidden="true" />{busy ? t.submitting : t.verify.submit}
		</Button>
		<Button variant="ghost" class="w-full" onclick={resend}><RefreshCw aria-hidden="true" />{t.verify.resend}</Button>
		{#if info === t.verify.resendByLogin}
			<Button href={resolve('connexion')} variant="outline" class="w-full">{t.login.submit}</Button>
		{/if}
	</form>
{/if}
