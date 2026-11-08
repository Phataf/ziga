<script lang="ts">
	import { resolve } from '$app/paths';
	import { resolvePath } from '#lib/nav.ts';
	/** Ordinateur : menu latéral par sections, espace en tête, compte en pied. */
	import { page } from '$app/state';
	import { ArrowLeftRight, Building2, CircleUserRound } from '@lucide/svelte';
	import { auth } from '#lib/auth/auth.svelte.ts';
	import LogoutButton from '#lib/components/auth/LogoutButton.svelte';
	import { fr } from '#lib/i18n/fr.ts';
	import { activeNav, menuOf, sectionsOf, type Profile } from '#lib/profiles.ts';
	import { cn } from '#lib/utils.ts';

	let { profile, spaceLabel }: { profile: Profile; spaceLabel: string } = $props();
	const current = $derived(activeNav(menuOf(profile), page.url.pathname));
	const sections = $derived(sectionsOf(profile));
</script>

<aside class="fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r bg-card" data-testid="menu-lateral">
	<div class="flex items-center gap-3 px-5 pt-5 pb-4">
		<span class="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground" aria-hidden="true">
			<Building2 class="size-5" />
		</span>
		<div class="min-w-0">
			<p class="truncate font-bold">{fr.app.name}</p>
			<p class="truncate text-sm text-muted-foreground">{spaceLabel}</p>
		</div>
	</div>

	<nav aria-label={fr.app.mainNav} class="flex-1 overflow-y-auto px-3 py-2">
		{#each sections as [title, items] (title)}
			<div class="mb-4">
				{#if title}<p class="px-3 pb-1 text-sm font-semibold tracking-wide text-muted-foreground uppercase">{title}</p>{/if}
				<ul class="space-y-0.5">
					{#each items as item (item.href)}
						{@const active = current?.href === item.href}
						<li>
							<!-- eslint-disable svelte/no-navigation-without-resolve -- resolvePath() appelle resolve() de $app/paths (src/lib/nav.ts) -->
							<a
								href={resolvePath(item.path)}
								aria-current={active ? 'page' : undefined}
								class={cn(
									'flex min-h-11 items-center gap-3 rounded-lg px-3',
									active
										? 'bg-secondary font-semibold text-secondary-foreground'
										: 'text-foreground/80 hover:bg-accent hover:text-foreground'
								)}
							>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
								<item.icon class="size-5 shrink-0" aria-hidden="true" />
								{item.label}
							</a>
						</li>
					{/each}
				</ul>
			</div>
		{/each}
	</nav>

	<div class="space-y-2 border-t p-3">
		{#if profile.space !== 'admin'}
			<a
				href={resolve('espace')}
				class="flex min-h-11 items-center gap-3 rounded-lg px-3 text-foreground/80 hover:bg-accent hover:text-foreground"
			>
				<ArrowLeftRight class="size-5 shrink-0" aria-hidden="true" />
				{fr.app.switchSpace}
			</a>
		{/if}
		<a
			href={resolve('espace/compte')}
			class="flex min-h-11 items-center gap-3 rounded-lg px-3 text-foreground/80 hover:bg-accent hover:text-foreground"
		>
			<CircleUserRound class="size-5 shrink-0" aria-hidden="true" />
			{fr.account.title}
		</a>
		<LogoutButton />
		{#if auth.user}<p class="truncate px-3 text-sm text-muted-foreground" data-testid="personne-connectee">{auth.user.name}</p>{/if}
	</div>
</aside>
