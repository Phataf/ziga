<script lang="ts">
	/** Téléphone : barre d'onglets en bas, 4 entrées au plus, pouce à portée (docs/UX.md §3). */
	import { page } from '$app/state';
	import { Ellipsis } from '@lucide/svelte';
	import { demo } from '$lib/demo.svelte';
	import { activeNav } from '$lib/profiles';
	import { cn } from '$lib/utils';

	const tabs = $derived.by(() => {
		// Sur téléphone, les impayés s'ouvrent depuis l'onglet des encaissements.
		const items = demo.profile.nav
			.filter((n) => n.tab)
			.map((n) => (n.href === '/encaissements' ? { ...n, match: [...n.match, '/impayes'] } : n));
		// L'espace agence garde un onglet « Plus » qui donne accès au reste du menu.
		if (demo.profile.space === 'agency') {
			items.push({ href: '/plus', label: 'Plus', icon: Ellipsis, match: ['/plus', '/proprietaires'], tab: true });
		}
		return items;
	});
	const current = $derived(activeNav(tabs, page.url.pathname));
</script>

<nav
	aria-label="Navigation principale"
	class="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
>
	<ul class="mx-auto flex max-w-lg">
		{#each tabs as tab (tab.href)}
			{@const active = current?.href === tab.href}
			<li class={cn('min-w-0 flex-1', tab.href === '/encaissements' && 'flex-[1.6]')}>
				<a
					href={tab.href}
					aria-current={active ? 'page' : undefined}
					class={cn(
						'flex min-h-16 flex-col items-center justify-center gap-0.5 text-base leading-tight',
						active ? 'font-semibold text-primary' : 'text-muted-foreground'
					)}
				>
					<span class={cn('flex h-7 w-12 items-center justify-center rounded-full', active && 'bg-secondary')}>
						<tab.icon class="size-5" aria-hidden="true" />
					</span>
					<span class="max-w-full truncate px-1">{tab.short ?? tab.label}</span>
				</a>
			</li>
		{/each}
	</ul>
</nav>
