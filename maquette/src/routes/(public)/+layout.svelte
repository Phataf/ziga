<script lang="ts">
	/**
	 * Vitrine publique (visiteurs et acheteurs) : pas de menu d'application.
	 * En-tête de site classique ; sur ordinateur, les rubriques sont dans la barre du haut.
	 */
	import { page } from '$app/state';
	import { Briefcase, Building2 } from '@lucide/svelte';
	import { demo } from '$lib/demo.svelte';
	import { cn } from '$lib/utils';

	let { children } = $props();
	const mode = $derived(page.url.searchParams.get('type') === 'achat' ? 'achat' : 'location');
	const onSearch = $derived(page.url.pathname.startsWith('/vitrine'));
</script>

<div class="min-h-dvh bg-white">
	<header class="sticky top-0 z-30 border-b bg-white/95 backdrop-blur">
		<div class="mx-auto flex min-h-14 max-w-7xl items-center gap-3 px-4 md:min-h-16 md:px-6">
			<a href="/vitrine" class="flex items-center gap-2 font-bold">
				<span class="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground" aria-hidden="true"><Building2 class="size-5" /></span>
				<span class="truncate">{demo.full.agency.name}</span>
			</a>
			{#if onSearch}
				<nav aria-label="Rubriques de la vitrine" class="ml-auto flex rounded-lg bg-muted p-1 md:ml-6">
					{#each [{ id: 'location', label: 'Louer', href: '/vitrine' }, { id: 'achat', label: 'Acheter', href: '/vitrine?type=achat' }] as r (r.id)}
						<a
							href={r.href}
							aria-current={mode === r.id ? 'page' : undefined}
							class={cn('flex min-h-10 items-center rounded-md px-4 font-medium', mode === r.id ? 'bg-white shadow-sm' : 'text-muted-foreground hover:text-foreground')}
							>{r.label}</a
						>
					{/each}
				</nav>
			{/if}
			<a
				href="/"
				class="ml-auto hidden min-h-10 items-center gap-2 rounded-lg px-3 text-muted-foreground hover:bg-accent hover:text-foreground md:flex"
				onclick={() => demo.setProfile('manager')}
			>
				<Briefcase class="size-[18px]" aria-hidden="true" /> Espace professionnel
			</a>
		</div>
	</header>
	{@render children()}
</div>
