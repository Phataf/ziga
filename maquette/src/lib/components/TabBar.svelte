<script lang="ts">
	import { page } from '$app/state';
	import { Building2, Ellipsis, House, Wallet } from '@lucide/svelte';
	import { cn } from '$lib/utils';

	const tabs = [
		{ href: '/', label: 'Accueil', icon: House, match: (p: string) => p === '/' },
		{ href: '/biens', label: 'Biens', icon: Building2, match: (p: string) => p.startsWith('/biens') },
		{
			href: '/encaissements',
			label: 'Encaissements',
			icon: Wallet,
			match: (p: string) => ['/encaissements', '/encaisser', '/recus', '/impayes'].some((x) => p.startsWith(x))
		},
		{
			href: '/plus',
			label: 'Plus',
			icon: Ellipsis,
			match: (p: string) => p.startsWith('/plus') || p.startsWith('/proprietaires')
		}
	];
</script>

<nav
	aria-label="Navigation principale"
	class="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
>
	<ul class="mx-auto grid max-w-lg grid-cols-[1fr_1fr_1.75fr_1fr]">
		{#each tabs as tab (tab.href)}
			{@const active = tab.match(page.url.pathname)}
			<li>
				<a
					href={tab.href}
					aria-current={active ? 'page' : undefined}
					class={cn(
						'flex min-h-16 flex-col items-center justify-center gap-0.5 text-base leading-tight',
						active ? 'font-semibold text-primary' : 'text-muted-foreground'
					)}
				>
					<span
						class={cn('flex h-7 w-12 items-center justify-center rounded-full', active && 'bg-secondary')}
					>
						<tab.icon class="size-5" aria-hidden="true" />
					</span>
					{tab.label}
				</a>
			</li>
		{/each}
	</ul>
</nav>
