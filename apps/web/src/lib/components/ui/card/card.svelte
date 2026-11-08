<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '#lib/utils.ts';

	let { class: className, children, ...restProps }: HTMLAttributes<HTMLDivElement> = $props();
</script>

<div class={cn('rounded-xl border bg-card text-card-foreground shadow-xs', className)} {...restProps}>
	{@render children?.()}
</div>
