<script lang="ts">
	/** Tablette : rail de navigation à gauche, icônes et libellés courts, cibles de 56 px. */
	import { page } from '$app/state';
	import { Wallet } from '@lucide/svelte';
	import { demo } from '$lib/demo.svelte';
	import { activeNav } from '$lib/profiles';
	import { cn } from '$lib/utils';
	import ProfileSwitcher from './ProfileSwitcher.svelte';

	const current = $derived(activeNav(demo.profile.nav, page.url.pathname));
	const canCollect = $derived(demo.profile.space === 'agency');
</script>

<nav
	aria-label="Navigation principale"
	class="fixed inset-y-0 left-0 z-40 hidden w-28 flex-col items-center gap-1 border-r bg-card py-3 md:flex xl:hidden"
>
	{#if canCollect}
		<a
			href="/encaisser"
			class="mb-3 flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
			aria-label="Encaisser un loyer"
			title="Encaisser un loyer"
		>
			<Wallet class="size-6" aria-hidden="true" />
		</a>
	{/if}
	<ul class="flex w-full flex-1 flex-col gap-1 px-2">
		{#each demo.profile.nav as item (item.href)}
			{@const active = current?.href === item.href}
			<li>
				<a
					href={item.href}
					aria-current={active ? 'page' : undefined}
					class={cn(
						'flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl px-0.5 text-center text-sm leading-tight',
						active ? 'font-semibold text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
					)}
				>
					<span class={cn('flex h-8 w-14 items-center justify-center rounded-full', active && 'bg-secondary')}>
						<item.icon class="size-[22px]" aria-hidden="true" />
					</span>
					{item.short ?? item.label}
				</a>
			</li>
		{/each}
	</ul>
	<div class="w-full px-2"><ProfileSwitcher variant="rail" /></div>
</nav>
