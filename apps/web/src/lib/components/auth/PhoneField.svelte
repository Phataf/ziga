<script lang="ts">
	/**
	 * Numéro de téléphone : indicatif du pays (+226 par défaut) et numéro national, clavier téléphonique.
	 * Le sélecteur natif est posé, invisible, sur l'indicatif affiché : la liste des pays reste celle du téléphone,
	 * accessible au lecteur d'écran, sans élargir le champ.
	 */
	import { COUNTRIES } from '@ziga/shared/phone';
	import { fr } from '#lib/i18n/fr.ts';
	import { cn } from '#lib/utils.ts';

	let {
		value = $bindable(''),
		country = $bindable('226'),
		error,
		id = 'telephone',
		autofocus = false
	}: { value?: string; country?: string; error?: string; id?: string; autofocus?: boolean } = $props();
	const t = fr.auth;
</script>

<div class="space-y-1">
	<label for={id} class="block font-medium">{t.phone}</label>
	<div class="flex gap-2">
		<div
			class="relative flex min-h-12 shrink-0 items-center rounded-lg border-2 border-input bg-card px-3 font-medium tabular-nums focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30"
		>
			<span aria-hidden="true">+{country}</span>
			<select
				class="absolute inset-0 cursor-pointer opacity-0"
				aria-label={t.country}
				title={t.countryCode(country)}
				bind:value={country}
				data-testid="pays"
			>
				{#each COUNTRIES as c (c.iso)}<option value={c.code}>{c.name} (+{c.code})</option>{/each}
			</select>
		</div>
		<!-- svelte-ignore a11y_autofocus -->
		<input
			{id}
			bind:value
			type="tel"
			inputmode="tel"
			autocomplete="tel-national"
			placeholder={country === '226' ? t.phonePlaceholder : ''}
			aria-invalid={error ? 'true' : undefined}
			aria-describedby="{id}-aide{error ? ` ${id}-erreur` : ''}"
			{autofocus}
			required
			class={cn(
				'flex min-h-12 w-full min-w-0 rounded-lg border-2 border-input bg-card px-3 py-2 text-base tabular-nums outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30',
				error && 'border-destructive'
			)}
		/>
	</div>
	<p id="{id}-aide" class="text-sm text-muted-foreground">{country === '226' ? t.phoneHint : t.otherCountryHint}</p>
	{#if error}<p id="{id}-erreur" class="text-base text-destructive">{error}</p>{/if}
</div>
