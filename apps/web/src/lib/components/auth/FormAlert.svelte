<script lang="ts">
	/** Message d'un formulaire : erreur (role="alert") ou information (role="status"). */
	import { CircleAlert, Info } from '@lucide/svelte';

	let { message, tone = 'error' }: { message?: string | null; tone?: 'error' | 'info' } = $props();
</script>

{#if message}
	{#if tone === 'error'}
		<p role="alert" class="flex items-start gap-2 rounded-lg bg-danger-soft p-3 text-base text-destructive" data-testid="erreur-formulaire">
			<CircleAlert class="mt-0.5 size-5 shrink-0" aria-hidden="true" />{message}
		</p>
	{:else}
		<p
			role="status"
			class="flex items-start gap-2 rounded-lg bg-info-soft p-3 text-base text-info-foreground"
			data-testid="info-formulaire"
		>
			<Info class="mt-0.5 size-5 shrink-0" aria-hidden="true" />{message}
		</p>
	{/if}
{/if}
