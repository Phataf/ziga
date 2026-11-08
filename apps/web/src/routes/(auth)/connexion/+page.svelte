<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { loginSchema } from '@ziga/shared/auth';
	import { LogIn } from '@lucide/svelte';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PasswordField from '#lib/components/auth/PasswordField.svelte';
	import PhoneField from '#lib/components/auth/PhoneField.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { auth } from '#lib/auth/auth.svelte.ts';
	import { fieldErrors, messageOf, phoneOf } from '#lib/auth/forms.ts';
	import { ApiError } from '#lib/auth/http.ts';
	import { safeReturn } from '#lib/auth/outcome.ts';
	import { fr } from '#lib/i18n/fr.ts';

	const t = fr.auth;
	let phone = $state('');
	let country = $state('226');
	let password = $state('');
	let errors = $state<Record<string, string>>({});
	let message = $state<string | null>(null);
	let busy = $state(false);
	const target = $derived(safeReturn(page.url.searchParams.get('retour')));

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		message = null;
		const number = phoneOf(phone, country);
		const parsed = loginSchema.safeParse({ phone: 'phone' in number ? number.phone : '', password });
		errors = { ...fieldErrors(parsed.error), ...('error' in number ? { phone: number.error } : {}) };
		if (!parsed.success || 'error' in number) return;
		busy = true;
		try {
			await auth.login({ phone: number.phone, password });
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- chemin interne vérifié par safeReturn()
			await goto(target, { replaceState: true });
		} catch (error) {
			if (error instanceof ApiError && error.code === 'PHONE_NOT_VERIFIED') {
				await goto(resolve(`verification?numero=${encodeURIComponent(number.phone)}&renvoye=1`));
				return;
			}
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>{fr.app.pageTitle(t.login.title)}</title></svelte:head>

<form class="space-y-5" onsubmit={submit} novalidate data-testid="formulaire-connexion">
	<div class="space-y-1">
		<h1 class="text-2xl font-bold">{t.login.title}</h1>
		<p class="text-base text-muted-foreground">{t.login.subtitle}</p>
	</div>
	<FormAlert {message} />
	<PhoneField bind:value={phone} bind:country error={errors.phone} autofocus />
	<PasswordField bind:value={password} error={errors.password} />
	<Button type="submit" size="lg" class="w-full" disabled={busy}>
		<LogIn aria-hidden="true" />{busy ? t.submitting : t.login.submit}
	</Button>
	<div class="flex flex-col gap-1 text-base">
		<a href={resolve('mot-de-passe-oublie')} class="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline"
			>{t.login.forgot}</a
		>
		<p class="flex flex-wrap items-center gap-x-2">
			{t.login.noAccount}
			<a
				href={resolve('inscription')}
				class="inline-flex min-h-11 items-center font-semibold text-primary underline-offset-4 hover:underline">{t.login.register}</a
			>
		</p>
	</div>
</form>
