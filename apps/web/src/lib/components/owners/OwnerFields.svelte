<script lang="ts">
	/**
	 * Champs d'une fiche propriétaire (lot 06) : création rapide et modification. Le strict nécessaire d'abord (type,
	 * nom, téléphone, pays de résidence) ; e-mail, adresse et notes repliés sous « Plus de détails ».
	 */
	import { OWNER_TYPES } from '@ziga/shared/owners';
	import { COUNTRIES } from '@ziga/shared/phone';
	import PhoneField from '#lib/components/auth/PhoneField.svelte';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import type { Errors, OwnerForm } from '#lib/owners/forms.ts';

	let { form = $bindable(), errors = {}, prefix = 'proprietaire' }: { form: OwnerForm; errors?: Errors; prefix?: string } = $props();
	const t = fr.owners;
	const field = 'space-y-1';
	const label = 'block font-medium';
	const select = 'min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 text-base';
	const error = (key: string) => (errors[key] ? `${prefix}-${key}-erreur` : undefined);
</script>

<div class={field}>
	<label for="{prefix}-type" class={label}>{t.type}</label>
	<select id="{prefix}-type" bind:value={form.type} class={select}>
		{#each OWNER_TYPES as type (type)}<option value={type}>{t.types[type]}</option>{/each}
	</select>
</div>
<div class={field}>
	<label for="{prefix}-nom" class={label}>{t.name}</label>
	<Input
		id="{prefix}-nom"
		bind:value={form.name}
		autocomplete="off"
		aria-invalid={errors.name ? 'true' : undefined}
		aria-describedby={error('name')}
	/>
	{#if errors.name}<p id="{prefix}-name-erreur" class="text-base text-destructive">{errors.name}</p>{/if}
</div>
<PhoneField
	bind:value={form.phone}
	bind:country={form.phoneCountry}
	error={errors.phone}
	id="{prefix}-telephone"
	label={t.phone}
	hint={t.phoneHint}
/>
<div class={field}>
	<label for="{prefix}-pays" class={label}>{t.country}</label>
	<select id="{prefix}-pays" bind:value={form.country} class={select}>
		{#each COUNTRIES as c (c.iso)}<option value={c.iso}>{c.name}</option>{/each}
	</select>
</div>
{#if form.type === 'group'}
	<fieldset class="space-y-4 rounded-xl border p-4">
		<legend class="px-1 font-semibold">{t.representative}</legend>
		<div class={field}>
			<label for="{prefix}-representant" class={label}>{t.repName}</label>
			<Input
				id="{prefix}-representant"
				bind:value={form.repName}
				aria-invalid={errors.repName ? 'true' : undefined}
				aria-describedby={error('repName')}
			/>
			{#if errors.repName}<p id="{prefix}-repName-erreur" class="text-base text-destructive">{errors.repName}</p>{/if}
		</div>
		<PhoneField
			bind:value={form.repPhone}
			bind:country={form.repPhoneCountry}
			error={errors.repPhone}
			id="{prefix}-telephone-representant"
			label={t.repPhone}
			hint={t.phoneHint}
		/>
	</fieldset>
{/if}
<details class="rounded-xl border p-4" open={!!(form.email || form.address || form.notes || errors.email)}>
	<summary class="min-h-11 cursor-pointer content-center font-medium">{t.more}</summary>
	<div class="mt-3 space-y-4">
		<div class={field}>
			<label for="{prefix}-email" class={label}>{t.email}</label>
			<Input
				id="{prefix}-email"
				type="email"
				inputmode="email"
				autocomplete="off"
				bind:value={form.email}
				aria-invalid={errors.email ? 'true' : undefined}
				aria-describedby={error('email')}
			/>
			{#if errors.email}<p id="{prefix}-email-erreur" class="text-base text-destructive">{errors.email}</p>{/if}
		</div>
		<div class={field}>
			<label for="{prefix}-adresse" class={label}>{t.address}</label>
			<Input id="{prefix}-adresse" bind:value={form.address} />
		</div>
		<div class={field}>
			<label for="{prefix}-notes" class={label}>{t.notes}</label>
			<textarea
				id="{prefix}-notes"
				bind:value={form.notes}
				rows="3"
				aria-describedby="{prefix}-notes-aide"
				class="w-full rounded-lg border-2 border-input bg-card px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30"
			></textarea>
			<p id="{prefix}-notes-aide" class="text-sm text-muted-foreground">{t.notesHint}</p>
		</div>
	</div>
</details>
