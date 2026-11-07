<script lang="ts">
	let { name, class: className = '' }: { name: string; class?: string } = $props();
	const initials = $derived(
		name
			.replace(/[’']/g, ' ')
			.split(/\s+/)
			.filter((w) => w.length > 2 || /^[A-ZÉ]/.test(w))
			.slice(0, 2)
			.map((w) => w[0]!.toUpperCase())
			.join('')
	);
</script>

<span
	class="flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary font-semibold text-secondary-foreground {className}"
	aria-hidden="true">{initials}</span
>
