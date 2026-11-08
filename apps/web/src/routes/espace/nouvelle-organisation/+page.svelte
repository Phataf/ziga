<script lang="ts">
	/** Création d'une organisation (lot 03) : le type d'abord, puis le minimum ; la fiche se complète dans les paramètres. */
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Building2, House } from '@lucide/svelte';
	import { newId } from '@ziga/shared/ids';
	import { createOrganizationSchema, type MembershipView } from '@ziga/shared/organizations';
	import type { OrganizationType } from '@ziga/shared/permissions';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PhoneField from '#lib/components/auth/PhoneField.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { auth } from '#lib/auth/auth.svelte.ts';
	import { fieldErrors, messageOf, phoneOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';

	const t = fr.organizations;
	let type = $state<OrganizationType | null>(null);
	let legalName = $state('');
	let phone = $state('');
	let country = $state('226');
	let commune = $state('');
	let errors = $state<Record<string, string>>({});
	let message = $state<string | null>(null);
	let busy = $state(false);
	// Identifiant généré une fois par le client (UUIDv7) : un double envoi ne crée pas deux organisations.
	const id = newId();

	function choose(value: OrganizationType) {
		type = value;
		if (value === 'landlord' && !legalName && auth.user) legalName = auth.user.name;
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!type) return;
		message = null;
		const number = phoneOf(phone, country);
		const parsed = createOrganizationSchema.safeParse({ id, type, legalName, phone: 'phone' in number ? number.phone : '', commune });
		errors = { ...fieldErrors(parsed.error), ...('error' in number ? { phone: number.error } : {}) };
		if (!parsed.success || 'error' in number) return;
		busy = true;
		try {
			const membership = await auth.request<MembershipView>('POST', '/organizations', parsed.data);
			organizations.add(membership);
			await goto(resolve('app'), { replaceState: true });
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}

	const card =
		'flex min-h-24 w-full items-center gap-4 rounded-xl border-2 border-input bg-card p-4 text-left hover:border-primary hover:bg-accent';
</script>

<PageHeader title={t.createTitle} subtitle={t.createSubtitle} back="espace" backLabel={fr.app.switchSpace} />

<main class="page-narrow space-y-5 pt-3 pb-10" data-testid="creation-organisation">
	{#if !type}
		<h2 class="text-lg font-semibold">{t.chooseType}</h2>
		<div class="space-y-3">
			<button type="button" class={card} onclick={() => choose('agency')} data-testid="type-agence">
				<span class="flex size-12 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground"
					><Building2 class="size-6" aria-hidden="true" /></span
				>
				<span
					><span class="block text-lg font-semibold">{t.agency}</span><span class="block text-base text-muted-foreground"
						>{t.agencyHint}</span
					></span
				>
			</button>
			<button type="button" class={card} onclick={() => choose('landlord')} data-testid="type-bailleur">
				<span class="flex size-12 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground"
					><House class="size-6" aria-hidden="true" /></span
				>
				<span
					><span class="block text-lg font-semibold">{t.landlord}</span><span class="block text-base text-muted-foreground"
						>{t.landlordHint}</span
					></span
				>
			</button>
		</div>
	{:else}
		<form class="space-y-5 rounded-2xl border bg-card p-5 md:p-6" onsubmit={submit} novalidate>
			<div class="flex flex-wrap items-center justify-between gap-2">
				<p class="flex items-center gap-2 font-semibold">
					{#if type === 'landlord'}<House class="size-5" aria-hidden="true" />{t.landlord}{:else}<Building2
							class="size-5"
							aria-hidden="true"
						/>{t.agency}{/if}
				</p>
				<Button variant="ghost" onclick={() => (type = null)}>{t.changeType}</Button>
			</div>
			<FormAlert {message} />
			<div class="space-y-1">
				<label for="raison-sociale" class="block font-medium">{t.legalName(type)}</label>
				<Input
					id="raison-sociale"
					bind:value={legalName}
					autocomplete="organization"
					aria-invalid={errors.legalName ? 'true' : undefined}
					required
				/>
				{#if errors.legalName}<p class="text-base text-destructive">{errors.legalName}</p>{/if}
			</div>
			<PhoneField bind:value={phone} bind:country error={errors.phone} id="telephone-organisation" label={t.phone} hint={t.phoneHint} />
			<div class="space-y-1">
				<label for="commune" class="block font-medium">{t.commune}</label>
				<Input
					id="commune"
					bind:value={commune}
					placeholder={t.communePlaceholder}
					autocomplete="address-level2"
					aria-invalid={errors.commune ? 'true' : undefined}
					required
				/>
				{#if errors.commune}<p class="text-base text-destructive">{errors.commune}</p>{/if}
			</div>
			<Button type="submit" size="lg" class="w-full" disabled={busy}>{busy ? fr.auth.submitting : t.submit}</Button>
		</form>
	{/if}
</main>
