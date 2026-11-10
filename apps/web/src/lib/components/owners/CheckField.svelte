<script lang="ts">
	/** Case à cocher sur toute la ligne (cible tactile de 48 px), le carré dessiné à côté du libellé. */
	import { Check } from '@lucide/svelte';

	let { checked = $bindable(false), label, disabled = false }: { checked?: boolean; label: string; disabled?: boolean } = $props();
</script>

<label
	class="relative flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border-2 border-input px-3 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-70"
>
	<input
		type="checkbox"
		class="peer absolute inset-0 size-full cursor-pointer appearance-none rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed"
		bind:checked
		{disabled}
	/>
	<span
		class="flex size-5 shrink-0 items-center justify-center rounded border-2 border-input text-primary-foreground peer-checked:border-primary peer-checked:bg-primary [&>svg]:invisible peer-checked:[&>svg]:visible"
		aria-hidden="true"
	>
		<Check class="size-4" />
	</span>
	<span class="text-base">{label}</span>
</label>
