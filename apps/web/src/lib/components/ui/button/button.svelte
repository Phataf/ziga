<script lang="ts" module>
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';
	import { tv, type VariantProps } from 'tailwind-variants';

	// Un libellé long passe à la ligne plutôt que de déborder de l'écran (téléphone de 360 px) : jamais de nowrap ici.
	export const buttonVariants = tv({
		base: 'inline-flex max-w-full shrink-0 items-center justify-center gap-2 rounded-lg text-center font-semibold transition-colors outline-none select-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*="size-"])]:size-5 active:scale-[0.98]',
		variants: {
			variant: {
				default: 'bg-primary text-primary-foreground hover:bg-primary/90',
				destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
				outline: 'border-2 border-input bg-card hover:bg-accent hover:text-accent-foreground',
				secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
				whatsapp: 'bg-[#1f8f4e] text-white hover:bg-[#1a7a42]',
				ghost: 'hover:bg-accent hover:text-accent-foreground',
				link: 'text-primary underline-offset-4 hover:underline'
			},
			size: {
				// Cibles tactiles ≥ 44 px (CLAUDE.md §6).
				default: 'min-h-11 px-4 py-2 text-base',
				lg: 'min-h-14 px-6 text-lg',
				icon: 'size-11'
			}
		},
		defaultVariants: { variant: 'default', size: 'default' }
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>['variant'];
	export type ButtonSize = VariantProps<typeof buttonVariants>['size'];

	export type ButtonProps = HTMLButtonAttributes &
		HTMLAnchorAttributes & {
			variant?: ButtonVariant;
			size?: ButtonSize;
			ref?: HTMLElement | null;
		};
</script>

<script lang="ts">
	import { cn } from '#lib/utils.ts';

	let {
		class: className,
		variant = 'default',
		size = 'default',
		ref = $bindable(null),
		href = undefined,
		type = 'button',
		children,
		...restProps
	}: ButtonProps = $props();
</script>

{#if href}
	<!-- Composant générique : l'appelant passe un lien déjà résolu (resolve() de $app/paths). -->
	<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
	<a bind:this={ref} class={cn(buttonVariants({ variant, size }), className)} {href} {...restProps}>
		{@render children?.()}
	</a>
{:else}
	<button bind:this={ref} class={cn(buttonVariants({ variant, size }), className)} {type} {...restProps}>
		{@render children?.()}
	</button>
{/if}
