<script lang="ts">
	/** Code à 6 chiffres reçu par SMS : clavier numérique, remplissage automatique du code. */
	import { fr } from '#lib/i18n/fr.ts';
	import { cn } from '#lib/utils.ts';

	let { value = $bindable(''), error, id = 'code' }: { value?: string; error?: string; id?: string } = $props();
</script>

<div class="space-y-1">
	<label for={id} class="block font-medium">{fr.auth.code}</label>
	<input
		{id}
		bind:value
		type="text"
		inputmode="numeric"
		autocomplete="one-time-code"
		pattern="[0-9]*"
		maxlength="6"
		aria-invalid={error ? 'true' : undefined}
		aria-describedby="{id}-aide{error ? ` ${id}-erreur` : ''}"
		required
		class={cn(
			'flex min-h-12 w-full max-w-48 rounded-lg border-2 border-input bg-card px-3 py-2 text-xl tracking-[0.3em] tabular-nums outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30',
			error && 'border-destructive'
		)}
	/>
	<p id="{id}-aide" class="text-sm text-muted-foreground">{fr.auth.codeHint}</p>
	{#if error}<p id="{id}-erreur" class="text-base text-destructive">{error}</p>{/if}
</div>
