<script lang="ts">
	import { resolve } from '$app/paths';
	/** Vitrine publique : rendue côté serveur, sans menu d'application ; en-tête de site avec Louer et Acheter. */
	import { page } from '$app/state';
	import { Building2 } from '@lucide/svelte';
	import { fr } from '#lib/i18n/fr.ts';
	import { profiles } from '#lib/profiles.ts';
	import { cn } from '#lib/utils.ts';

	let { children } = $props();
</script>

<div class="min-h-dvh bg-white">
	<header class="sticky top-0 z-30 border-b bg-white/95 backdrop-blur">
		<div class="mx-auto flex min-h-16 max-w-7xl items-center gap-3 px-4 md:px-6">
			<a href={resolve('')} class="flex min-h-11 items-center gap-2 font-bold">
				<span class="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground" aria-hidden="true"
					><Building2 class="size-5" /></span
				>
				<span class="hidden sm:inline">{fr.app.name}</span>
			</a>
			<nav aria-label={fr.spaces.public} class="ml-auto flex gap-1" data-testid="entete-vitrine">
				{#each profiles.visitor.nav as item (item.href)}
					<a
						href={resolve(item.path)}
						aria-current={page.url.pathname === item.href ? 'page' : undefined}
						class={cn(
							'flex min-h-11 items-center gap-2 rounded-lg px-3 font-medium',
							page.url.pathname === item.href ? 'bg-secondary text-secondary-foreground' : 'hover:bg-accent'
						)}
					>
						<item.icon class="size-5" aria-hidden="true" />{item.label}
					</a>
				{/each}
			</nav>
		</div>
	</header>
	{@render children()}
</div>
