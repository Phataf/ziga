<script lang="ts">
	/** Mot de passe, avec un bouton « Afficher » (pictogramme et mot). */
	import { Eye, EyeOff } from '@lucide/svelte';
	import { fr } from '#lib/i18n/fr.ts';
	import { cn } from '#lib/utils.ts';

	let {
		value = $bindable(''),
		label = fr.auth.password,
		hint,
		error,
		id = 'mot-de-passe',
		autocomplete = 'current-password'
	}: {
		value?: string;
		label?: string;
		hint?: string;
		error?: string;
		id?: string;
		autocomplete?: 'current-password' | 'new-password';
	} = $props();
	let visible = $state(false);
	const described = $derived([hint && `${id}-aide`, error && `${id}-erreur`].filter(Boolean).join(' ') || undefined);
</script>

<div class="space-y-1">
	<label for={id} class="block font-medium">{label}</label>
	<div class="flex gap-2">
		<input
			{id}
			bind:value
			type={visible ? 'text' : 'password'}
			{autocomplete}
			aria-invalid={error ? 'true' : undefined}
			aria-describedby={described}
			required
			class={cn(
				'flex min-h-12 w-full min-w-0 rounded-lg border-2 border-input bg-card px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30',
				error && 'border-destructive'
			)}
		/>
		<button
			type="button"
			class="flex min-h-12 shrink-0 items-center gap-1 rounded-lg border-2 border-input bg-card px-3 text-base hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
			aria-pressed={visible}
			aria-controls={id}
			onclick={() => (visible = !visible)}
		>
			{#if visible}<EyeOff class="size-5" aria-hidden="true" />{fr.auth.hidePassword}{:else}<Eye class="size-5" aria-hidden="true" />{fr
					.auth.showPassword}{/if}
		</button>
	</div>
	{#if hint}<p id="{id}-aide" class="text-sm text-muted-foreground">{hint}</p>{/if}
	{#if error}<p id="{id}-erreur" class="text-base text-destructive">{error}</p>{/if}
</div>
