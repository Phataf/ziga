<script lang="ts">
	import { resolve } from '$app/paths';
	import { resolvePath } from '#lib/nav.ts';
	/** Tablette : rail de navigation à gauche, cibles de 56 px, libellés courts. */
	import { page } from '$app/state';
	import { CircleUserRound } from '@lucide/svelte';
	import { fr } from '#lib/i18n/fr.ts';
	import { activeNav, menuOf, type Profile } from '#lib/profiles.ts';
	import { cn } from '#lib/utils.ts';

	let { profile }: { profile: Profile } = $props();
	const items = $derived(menuOf(profile));
	const current = $derived(activeNav(items, page.url.pathname));
</script>

<div class="fixed inset-y-0 left-0 z-40 flex w-28 flex-col border-r bg-card py-3" data-testid="rail">
	<nav aria-label={fr.app.mainNav} class="flex flex-1 flex-col items-center gap-1 overflow-y-auto">
		<ul class="flex w-full flex-1 flex-col gap-1 px-2">
			{#each items as item (item.href)}
				{@const active = current?.href === item.href}
				<li>
					<!-- eslint-disable svelte/no-navigation-without-resolve -- resolvePath() appelle resolve() de $app/paths (src/lib/nav.ts) -->
					<a
						href={resolvePath(item.path)}
						aria-current={active ? 'page' : undefined}
						class={cn(
							'flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl px-0.5 text-center text-sm leading-tight',
							active ? 'font-semibold text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
						)}
					>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
						<span class={cn('flex h-8 w-14 items-center justify-center rounded-full', active && 'bg-secondary')}>
							<item.icon class="size-6" aria-hidden="true" />
						</span>
						{item.short ?? item.label}
					</a>
				</li>
			{/each}
		</ul>
	</nav>
	<a
		href={resolve('espace/compte')}
		aria-current={page.url.pathname === '/espace/compte' ? 'page' : undefined}
		class="mx-2 flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl px-0.5 text-center text-sm leading-tight text-muted-foreground hover:bg-accent hover:text-foreground"
	>
		<CircleUserRound class="size-6" aria-hidden="true" />
		{fr.auth.account}
	</a>
</div>
