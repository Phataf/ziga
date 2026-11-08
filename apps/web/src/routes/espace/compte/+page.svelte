<script lang="ts">
	/**
	 * Mon compte (lot 03, complément c) : nom, mot de passe (ancien exigé, autres appareils déconnectés),
	 * numéro (code au nouveau numéro, ancien numéro prévenu). Chaque changement est journalisé.
	 */
	import { resolve } from '$app/paths';
	import { ChevronRight, KeyRound, MonitorSmartphone, Phone, Save } from '@lucide/svelte';
	import type { MeResponse } from '@ziga/shared/auth';
	import { changePasswordSchema, changePhoneSchema, updateProfileSchema } from '@ziga/shared/organizations';
	import { formatPhone } from '@ziga/shared/phone';
	import CodeField from '#lib/components/auth/CodeField.svelte';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PasswordField from '#lib/components/auth/PasswordField.svelte';
	import PhoneField from '#lib/components/auth/PhoneField.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { auth } from '#lib/auth/auth.svelte.ts';
	import { fieldErrors, messageOf, phoneOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';

	const t = fr.account;
	let name = $state(auth.user?.name ?? '');
	let nameError = $state<string | undefined>();
	let nameInfo = $state<string | null>(null);

	let currentPassword = $state('');
	let newPassword = $state('');
	let passwordErrors = $state<Record<string, string>>({});
	let passwordMessage = $state<string | null>(null);
	let passwordInfo = $state<string | null>(null);

	let phone = $state('');
	let country = $state('226');
	let phonePassword = $state('');
	let code = $state('');
	let pendingPhone = $state<string | null>(null);
	let phoneError = $state<string | undefined>();
	let phoneMessage = $state<string | null>(null);
	let phoneInfo = $state<string | null>(null);
	let busy = $state(false);

	async function saveName(event: SubmitEvent) {
		event.preventDefault();
		nameInfo = null;
		const parsed = updateProfileSchema.safeParse({ name });
		nameError = parsed.success ? undefined : parsed.error.issues[0]?.message;
		if (!parsed.success) return;
		try {
			auth.setUser(await auth.request<MeResponse>('PATCH', '/me', parsed.data));
			nameInfo = t.nameSaved;
		} catch (error) {
			nameError = messageOf(error);
		}
	}

	async function savePassword(event: SubmitEvent) {
		event.preventDefault();
		passwordMessage = null;
		passwordInfo = null;
		const parsed = changePasswordSchema.safeParse({ currentPassword, newPassword });
		passwordErrors = fieldErrors(parsed.error);
		if (!parsed.success) return;
		busy = true;
		try {
			await auth.request('POST', '/me/password', parsed.data);
			currentPassword = '';
			newPassword = '';
			passwordInfo = t.passwordChanged;
		} catch (error) {
			passwordMessage = messageOf(error);
		} finally {
			busy = false;
		}
	}

	async function askCode(event: SubmitEvent) {
		event.preventDefault();
		phoneMessage = null;
		const number = phoneOf(phone, country);
		phoneError = 'error' in number ? number.error : undefined;
		const parsed = changePhoneSchema.safeParse({ phone: 'phone' in number ? number.phone : '', password: phonePassword });
		if ('error' in number) return;
		if (!parsed.success) {
			phoneMessage = parsed.error.issues[0]?.message ?? null;
			return;
		}
		busy = true;
		try {
			await auth.request('POST', '/me/phone', { phone: number.phone, password: phonePassword });
			pendingPhone = number.phone;
			phonePassword = '';
			phoneInfo = t.codeSent(formatPhone(number.phone));
		} catch (error) {
			phoneMessage = messageOf(error);
		} finally {
			busy = false;
		}
	}

	async function confirm(event: SubmitEvent) {
		event.preventDefault();
		if (!pendingPhone) return;
		phoneMessage = null;
		busy = true;
		try {
			auth.setUser(await auth.request<MeResponse>('POST', '/me/phone/confirm', { phone: pendingPhone, code: code.trim() }));
			pendingPhone = null;
			code = '';
			phone = '';
			phoneInfo = t.phoneChanged;
		} catch (error) {
			phoneMessage = messageOf(error);
		} finally {
			busy = false;
		}
	}

	const section = 'space-y-4 rounded-2xl border bg-card p-4 md:p-6';
</script>

<PageHeader title={t.title} subtitle={t.subtitle} back="espace" backLabel={fr.app.switchSpace} />

<main class="page-narrow space-y-4 pt-3 pb-10" data-testid="mon-compte">
	<form class={section} onsubmit={saveName} novalidate>
		<h2 class="text-lg font-semibold">{t.name}</h2>
		<div class="space-y-1">
			<label for="nom-compte" class="block font-medium">{fr.auth.name}</label>
			<Input id="nom-compte" bind:value={name} autocomplete="name" aria-invalid={nameError ? 'true' : undefined} />
			{#if nameError}<p class="text-base text-destructive">{nameError}</p>{/if}
		</div>
		<FormAlert message={nameInfo} tone="info" />
		<Button type="submit"><Save aria-hidden="true" />{t.saveName}</Button>
	</form>

	<form class={section} onsubmit={savePassword} novalidate>
		<h2 class="flex items-center gap-2 text-lg font-semibold"><KeyRound class="size-5" aria-hidden="true" />{t.password}</h2>
		<FormAlert message={passwordMessage} />
		<PasswordField bind:value={currentPassword} label={t.currentPassword} id="mot-de-passe-actuel" error={passwordErrors.currentPassword} />
		<PasswordField
			bind:value={newPassword}
			label={t.newPassword}
			id="nouveau-mot-de-passe"
			hint={fr.auth.passwordHint}
			autocomplete="new-password"
			error={passwordErrors.newPassword}
		/>
		<FormAlert message={passwordInfo} tone="info" />
		<Button type="submit" disabled={busy}>{t.changePassword}</Button>
	</form>

	<section class={section} aria-labelledby="titre-numero">
		<h2 id="titre-numero" class="flex items-center gap-2 text-lg font-semibold"><Phone class="size-5" aria-hidden="true" />{t.phone}</h2>
		{#if auth.user?.phone}<p class="text-base text-muted-foreground tabular-nums">{t.currentPhone(formatPhone(auth.user.phone))}</p>{/if}
		<FormAlert message={phoneMessage} />
		<FormAlert message={phoneInfo} tone="info" />
		{#if !pendingPhone}
			<form class="space-y-4" onsubmit={askCode} novalidate>
				<PhoneField bind:value={phone} bind:country error={phoneError} id="nouveau-numero" label={t.newPhone} />
				<PasswordField bind:value={phonePassword} id="mot-de-passe-numero" />
				<Button type="submit" disabled={busy}>{t.sendCode}</Button>
			</form>
		{:else}
			<form class="space-y-4" onsubmit={confirm} novalidate>
				<CodeField bind:value={code} id="code-numero" />
				<Button type="submit" disabled={busy}>{t.confirmPhone}</Button>
			</form>
		{/if}
	</section>

	<a href={resolve('espace/appareils')} class="flex min-h-14 items-center gap-3 rounded-xl border bg-card px-4 hover:bg-accent">
		<MonitorSmartphone class="size-5 shrink-0" aria-hidden="true" />
		<span class="flex-1">{t.devices}</span>
		<ChevronRight class="size-5 text-muted-foreground" aria-hidden="true" />
	</a>
</main>
