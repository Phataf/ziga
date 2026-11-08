<script lang="ts">
	/** Ordinateur : menu latéral fixe, sections nommées, action principale en tête, profil en pied. */
	import { page } from '$app/state';
	import { ArrowLeftRight, Building2, ExternalLink, Wallet } from '@lucide/svelte';
	import { demo } from '$lib/demo.svelte';
	import { activeNav, type NavItem } from '$lib/profiles';
	import { cn } from '$lib/utils';
	import ProfileSwitcher from './ProfileSwitcher.svelte';

	const current = $derived(activeNav(demo.profile.nav, page.url.pathname));
	const sections = $derived.by(() => {
		const map = new Map<string, NavItem[]>();
		for (const item of demo.profile.nav.filter((n) => !n.phoneOnly)) {
			const key = item.section ?? '';
			map.set(key, [...(map.get(key) ?? []), item]);
		}
		return [...map.entries()];
	});
	const spaceLabel = $derived(
		{
			agency: demo.profileId === 'landlord' ? 'Espace bailleur' : 'Espace agence',
			owner: 'Espace propriétaire',
			tenant: 'Espace locataire',
			public: 'Vitrine',
			admin: 'Back-office plateforme'
		}[
			demo.profile.space
		]
	);
	const canCollect = $derived(demo.profile.space === 'agency');
	/** Une personne qui a plusieurs espaces en change depuis le menu du compte (docs/UX.md §2). */
	const canSwitchSpace = $derived(demo.profileId === 'owner' || demo.profileId === 'landlord');
	const headName = $derived(demo.profile.space === 'owner' ? `${demo.ownerPerson.civility} ${demo.ownerPerson.name}` : demo.profile.space === 'tenant' ? `${demo.tenantPerson.civility} ${demo.tenantPerson.name}` : demo.workspaceName);
</script>

<aside class="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col border-r bg-card xl:flex">
	<div class="flex items-center gap-3 px-5 pt-5 pb-4">
		<span class="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground" aria-hidden="true">
			<Building2 class="size-5" />
		</span>
		<div class="min-w-0">
			<p class="truncate font-bold">{headName}</p>
			<p class="truncate text-sm text-muted-foreground">{spaceLabel}</p>
		</div>
	</div>

	{#if canCollect}
		<div class="px-4 pb-2">
			<a
				href="/encaisser"
				class="flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 font-semibold text-primary-foreground hover:bg-primary/90"
			>
				<Wallet class="size-5" aria-hidden="true" /> Encaisser un loyer
			</a>
		</div>
	{/if}

	<nav aria-label="Navigation principale" class="flex-1 overflow-y-auto px-3 py-2">
		{#each sections as [title, items] (title)}
			<div class="mb-4">
				{#if title}<p class="px-3 pb-1 text-sm font-semibold tracking-wide text-muted-foreground uppercase">{title}</p>{/if}
				<ul class="space-y-0.5">
					{#each items as item (item.href)}
						{@const active = current?.href === item.href}
						<li>
							<a
								href={item.href}
								aria-current={active ? 'page' : undefined}
								class={cn(
									'flex min-h-10 items-center gap-3 rounded-lg px-3',
									active ? 'bg-secondary font-semibold text-secondary-foreground' : 'text-foreground/80 hover:bg-accent hover:text-foreground'
								)}
							>
								<item.icon class="size-5 shrink-0" aria-hidden="true" />
								{item.label}
							</a>
						</li>
					{/each}
				</ul>
			</div>
		{/each}
		{#if demo.profile.space === 'agency'}
			<a href="/vitrine" class="flex min-h-10 items-center gap-3 rounded-lg px-3 text-foreground/80 hover:bg-accent hover:text-foreground">
				<ExternalLink class="size-5 shrink-0" aria-hidden="true" /> Voir la vitrine
			</a>
		{/if}
	</nav>

	<div class="border-t p-3">
		{#if canSwitchSpace}
			<a href="/espaces" class="mb-2 flex min-h-10 items-center gap-3 rounded-lg px-3 text-foreground/80 hover:bg-accent hover:text-foreground">
				<ArrowLeftRight class="size-5 shrink-0" aria-hidden="true" /> Changer d’espace
			</a>
		{/if}
		<ProfileSwitcher variant="sidebar" />
		<p class="px-1 pt-2 text-sm text-muted-foreground">Maquette — données fictives</p>
	</div>
</aside>
