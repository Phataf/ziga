<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { registerSchema } from '@ziga/shared/auth';
	import { UserPlus } from '@lucide/svelte';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PasswordField from '#lib/components/auth/PasswordField.svelte';
	import PhoneField from '#lib/components/auth/PhoneField.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { auth } from '#lib/auth/auth.svelte.ts';
	import { fieldErrors, messageOf, phoneOf } from '#lib/auth/forms.ts';
	import { pendingRegistration } from '#lib/auth/pending.ts';
	import { fr } from '#lib/i18n/fr.ts';

	const t = fr.auth;
	let name = $state('');
	let phone = $state('');
	let country = $state('226');
	let password = $state('');
	let errors = $state<Record<string, string>>({});
	let message = $state<string | null>(null);
	let busy = $state(false);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		message = null;
		const number = phoneOf(phone, country);
		const parsed = registerSchema.safeParse({ phone: 'phone' in number ? number.phone : '', name, password });
		errors = { ...fieldErrors(parsed.error), ...('error' in number ? { phone: number.error } : {}) };
		if (!parsed.success || 'error' in number) return;
		busy = true;
		try {
			const input = { phone: number.phone, name: parsed.data.name, password };
			await auth.register(input);
			pendingRegistration.value = input;
			const retour = page.url.searchParams.get('retour');
			await goto(
				resolve(`verification?numero=${encodeURIComponent(number.phone)}${retour ? `&retour=${encodeURIComponent(retour)}` : ''}`)
			);
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>{fr.app.pageTitle(t.register.title)}</title></svelte:head>

<form class="space-y-5" onsubmit={submit} novalidate data-testid="formulaire-inscription">
	<div class="space-y-1">
		<h1 class="text-2xl font-bold">{t.register.title}</h1>
		<p class="text-base text-muted-foreground">{t.register.subtitle}</p>
	</div>
	<FormAlert {message} />
	<div class="space-y-1">
		<label for="nom" class="block font-medium">{t.name}</label>
		<Input
			id="nom"
			bind:value={name}
			autocomplete="name"
			placeholder={t.namePlaceholder}
			aria-invalid={errors.name ? 'true' : undefined}
			aria-describedby={errors.name ? 'nom-erreur' : undefined}
			required
		/>
		{#if errors.name}<p id="nom-erreur" class="text-base text-destructive">{errors.name}</p>{/if}
	</div>
	<PhoneField bind:value={phone} bind:country error={errors.phone} />
	<PasswordField bind:value={password} error={errors.password} hint={t.passwordHint} autocomplete="new-password" />
	<Button type="submit" size="lg" class="w-full" disabled={busy}>
		<UserPlus aria-hidden="true" />{busy ? t.submitting : t.register.submit}
	</Button>
	<p class="flex flex-wrap items-center gap-x-2 text-base">
		{t.register.hasAccount}
		<a href={resolve('connexion')} class="inline-flex min-h-11 items-center font-semibold text-primary underline-offset-4 hover:underline"
			>{t.register.login}</a
		>
	</p>
</form>
