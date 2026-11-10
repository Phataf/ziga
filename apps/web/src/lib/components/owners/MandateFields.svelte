<script lang="ts">
	/**
	 * Conditions d'un mandat (lot 06) : type (à la création seulement), dates, commission (taux en pourcentage ou
	 * montant en FCFA, clavier numérique), autorisations et exclusivité.
	 */
	import { COMMISSION_BASES, CREATABLE_MANDATE_TYPES, type MandateType } from '@ziga/shared/owners';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { withType, type Errors, type MandateForm } from '#lib/owners/forms.ts';
	import CheckField from './CheckField.svelte';

	let {
		form = $bindable(),
		errors = {},
		prefix = 'mandat',
		typeEditable = true
	}: { form: MandateForm; errors?: Errors; prefix?: string; typeEditable?: boolean } = $props();
	const t = fr.mandates;
	const field = 'space-y-1';
	const label = 'block font-medium';
	const select = 'min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 text-base';

	function changeType(type: MandateType) {
		form = withType(form, type);
	}
</script>

{#if typeEditable}
	<div class={field}>
		<label for="{prefix}-type" class={label}>{t.type}</label>
		<select id="{prefix}-type" value={form.type} onchange={(e) => changeType(e.currentTarget.value as MandateType)} class={select}>
			{#each CREATABLE_MANDATE_TYPES as type (type)}<option value={type}>{t.types[type]}</option>{/each}
		</select>
	</div>
{/if}
<div class="grid gap-4 sm:grid-cols-2">
	<div class={field}>
		<label for="{prefix}-debut" class={label}>{t.startsOn}</label>
		<Input id="{prefix}-debut" type="date" bind:value={form.startsOn} aria-invalid={errors.startsOn ? 'true' : undefined} />
		{#if errors.startsOn}<p class="text-base text-destructive">{errors.startsOn}</p>{/if}
	</div>
	<div class={field}>
		<label for="{prefix}-fin" class={label}>{t.endsOn}</label>
		<Input
			id="{prefix}-fin"
			type="date"
			bind:value={form.endsOn}
			aria-invalid={errors.endsOn ? 'true' : undefined}
			aria-describedby={errors.endsOn ? `${prefix}-fin-erreur` : undefined}
		/>
		{#if errors.endsOn}<p id="{prefix}-fin-erreur" class="text-base text-destructive">{errors.endsOn}</p>{/if}
	</div>
</div>
<div class="grid gap-4 sm:grid-cols-2">
	<div class={field}>
		<label for="{prefix}-base" class={label}>{t.commission}</label>
		<select
			id="{prefix}-base"
			bind:value={form.basis}
			class={select}
			aria-invalid={errors.basis ? 'true' : undefined}
			aria-describedby={errors.basis ? `${prefix}-base-erreur` : undefined}
		>
			<option value="">{t.noCommission}</option>
			{#each COMMISSION_BASES as basis (basis)}<option value={basis}>{t.bases[basis]}</option>{/each}
		</select>
		{#if errors.basis}<p id="{prefix}-base-erreur" class="text-base text-destructive">{errors.basis}</p>{/if}
	</div>
	{#if form.basis === 'percent_of_collected'}
		<div class={field}>
			<label for="{prefix}-taux" class={label}>{t.rate}</label>
			<Input
				id="{prefix}-taux"
				inputmode="decimal"
				bind:value={form.rate}
				aria-invalid={errors.rate ? 'true' : undefined}
				aria-describedby={errors.rate ? `${prefix}-taux-erreur` : undefined}
			/>
			{#if errors.rate}<p id="{prefix}-taux-erreur" class="text-base text-destructive">{errors.rate}</p>{/if}
		</div>
	{:else if form.basis}
		<div class={field}>
			<label for="{prefix}-montant" class={label}>{t.amount}</label>
			<Input
				id="{prefix}-montant"
				inputmode="numeric"
				bind:value={form.amount}
				aria-invalid={errors.amount ? 'true' : undefined}
				aria-describedby={errors.amount ? `${prefix}-montant-erreur` : undefined}
			/>
			{#if errors.amount}<p id="{prefix}-montant-erreur" class="text-base text-destructive">{errors.amount}</p>{/if}
		</div>
	{/if}
</div>
<fieldset class="space-y-2">
	<legend class="mb-1 font-medium">{t.authorizations}</legend>
	<CheckField bind:checked={form.canPublish} label={t.authorization.canPublish} />
	<CheckField bind:checked={form.canTakePhotos} label={t.authorization.canTakePhotos} />
	<CheckField bind:checked={form.canCollectFunds} label={t.authorization.canCollectFunds} />
	<CheckField bind:checked={form.canSignLeases} label={t.authorization.canSignLeases} />
	<CheckField bind:checked={form.exclusive} label={t.exclusive} />
</fieldset>
