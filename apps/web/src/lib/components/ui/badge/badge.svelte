<script lang="ts" module>
	import { tv, type VariantProps } from 'tailwind-variants';

	export const badgeVariants = tv({
		base: 'inline-flex w-fit shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-base font-medium whitespace-nowrap [&>svg]:size-4',
		variants: {
			variant: {
				default: 'border-transparent bg-primary text-primary-foreground',
				secondary: 'border-transparent bg-secondary text-secondary-foreground',
				success: 'border-transparent bg-success-soft text-secondary-foreground',
				warning: 'border-transparent bg-warning-soft text-warning-foreground',
				danger: 'border-transparent bg-danger-soft text-destructive',
				info: 'border-transparent bg-info-soft text-info-foreground',
				outline: 'text-foreground'
			}
		},
		defaultVariants: { variant: 'default' }
	});

	export type BadgeVariant = VariantProps<typeof badgeVariants>['variant'];
</script>

<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '#lib/utils.ts';

	let {
		class: className,
		variant = 'default',
		children,
		...restProps
	}: HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant } = $props();
</script>

<span class={cn(badgeVariants({ variant }), className)} {...restProps}>
	{@render children?.()}
</span>
