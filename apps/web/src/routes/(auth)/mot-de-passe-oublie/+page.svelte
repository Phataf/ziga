<script lang="ts">
	/** Mot de passe oublié, en deux étapes sur le même écran : numéro, puis code et nouveau mot de passe. */
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { AUTH_MESSAGES, otpCodeSchema, resetPasswordSchema } from '@ziga/shared/auth';
	import { formatPhone } from '@ziga/shared/phone';
	import { KeyRound, Send } from '@lucide/svelte';
	import CodeField from '#lib/components/auth/CodeField.svelte';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PasswordField from '#lib/components/auth/PasswordField.svelte';
	import PhoneField from '#lib/components/auth/PhoneField.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { auth } from '#lib/auth/auth.svelte.ts';
	import { fieldErrors, messageOf, phoneOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';

	const t = fr.auth;
	let step = $state<'phone' | 'reset'>('phone');
	let phone = $state('');
	let country = $state('226');
	let e164 = $state('');
	let code = $state('');
	let password = $state('');
	let errors = $state<Record<string, string>>({});
	let message = $state<string | null>(null);
	let busy = $state(false);

	async function askCode(event: SubmitEvent) {
		event.preventDefault();
		message = null;
		const number = phoneOf(phone, country);
		errors = 'error' in number ? { phone: number.error } : {};
		if ('error' in number) return;
		busy = true;
		try {
			await auth.forgotPassword({ phone: number.phone });
			e164 = number.phone;
			step = 'reset';
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}

	async function reset(event: SubmitEvent) {
		event.preventDefault();
		message = null;
		const parsed = resetPasswordSchema.safeParse({ phone: e164, code: code.trim(), password });
		errors = fieldErrors(parsed.error);
		if (!parsed.success) return;
		busy = true;
		try {
			await auth.resetPassword({ phone: e164, code: otpCodeSchema.parse(code.trim()), password });
			await goto(resolve('espace'), { replaceState: true });
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>{fr.app.pageTitle(t.forgot.title)}</title></svelte:head>

{#if step === 'phone'}
	<form class="space-y-5" onsubmit={askCode} novalidate data-testid="formulaire-oubli">
		<div class="space-y-1">
			<h1 class="text-2xl font-bold">{t.forgot.title}</h1>
			<p class="text-base text-muted-foreground">{t.forgot.subtitle}</p>
		</div>
		<FormAlert {message} />
		<PhoneField bind:value={phone} bind:country error={errors.phone} autofocus />
		<Button type="submit" size="lg" class="w-full" disabled={busy}
			><Send aria-hidden="true" />{busy ? t.submitting : t.forgot.submit}</Button
		>
		<a href={resolve('connexion')} class="inline-flex min-h-11 items-center text-base text-primary underline-offset-4 hover:underline"
			>{t.login.submit}</a
		>
	</form>
{:else}
	<form class="space-y-5" onsubmit={reset} novalidate data-testid="formulaire-reinitialisation">
		<div class="space-y-1">
			<h1 class="text-2xl font-bold">{t.forgot.resetTitle}</h1>
			<p class="text-base text-muted-foreground">{t.forgot.resetSubtitle(formatPhone(e164))}</p>
		</div>
		<FormAlert message={AUTH_MESSAGES.codeSent} tone="info" />
		<FormAlert {message} />
		<CodeField bind:value={code} error={errors.code} />
		<PasswordField
			bind:value={password}
			label={t.newPassword}
			hint={t.passwordHint}
			error={errors.password}
			id="nouveau-mot-de-passe"
			autocomplete="new-password"
		/>
		<Button type="submit" size="lg" class="w-full" disabled={busy}
			><KeyRound aria-hidden="true" />{busy ? t.submitting : t.forgot.resetSubmit}</Button
		>
		<Button variant="ghost" class="w-full" onclick={() => ((step = 'phone'), (code = ''), (message = null))}>{t.forgot.otherNumber}</Button>
	</form>
{/if}
