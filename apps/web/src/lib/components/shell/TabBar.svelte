<script lang="ts">
	import { resolve } from '$app/paths';
	/** Téléphone : barre d'onglets en bas, 4 entrées au plus, chacune avec son mot (docs/UX.md §3). */
	import { page } from '$app/state';
	import { fr } from '#lib/i18n/fr.ts';
	import { activeNav, tabsOf, type Profile } from '#lib/profiles.ts';
	import { cn } from '#lib/utils.ts';

	let { profile }: { profile: Profile } = $props();
	const tabs = $derived(tabsOf(profile));
	// L'écran ouvert est l'entrée de navigation la plus précise ; s'il n'a pas d'onglet, « Plus » est actif.
	const current = $derived.by(() => {
		const item = activeNav(profile.nav, page.url.pathname);
		if (!item) return undefined;
		return item.tab ? item : tabs.find((t) => t.phoneOnly);
	});
</script>

<nav
	aria-label={fr.app.mainNav}
	class="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
	data-testid="barre-onglets"
>
	<ul class="mx-auto flex max-w-lg">
		{#each tabs as tab (tab.href)}
			{@const active = current?.href === tab.href}
			<li class="min-w-0 flex-1">
				<a
					href={resolve(tab.path)}
					aria-current={active ? 'page' : undefined}
					class={cn(
						'flex min-h-16 flex-col items-center justify-center gap-0.5 text-base leading-tight',
						active ? 'font-semibold text-primary' : 'text-muted-foreground'
					)}
				>
					<span class={cn('flex h-7 w-12 items-center justify-center rounded-full', active && 'bg-secondary')}>
						<tab.icon class="size-6" aria-hidden="true" />
					</span>
					<span class="max-w-full truncate px-1">{tab.short ?? tab.label}</span>
				</a>
			</li>
		{/each}
	</ul>
</nav>
