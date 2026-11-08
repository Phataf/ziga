<script lang="ts">
	import { resolve } from '$app/paths';
	/** Téléphone : écran « Plus », avec les entrées qui n'ont pas d'onglet. */
	import { ArrowLeftRight, ChevronRight, CircleUserRound } from '@lucide/svelte';
	import LogoutButton from './auth/LogoutButton.svelte';
	import { fr } from '#lib/i18n/fr.ts';
	import { moreOf, type Profile } from '#lib/profiles.ts';
	import PageHeader from './PageHeader.svelte';

	let { profile }: { profile: Profile } = $props();
	const items = $derived(moreOf(profile));
</script>

<PageHeader title={fr.app.more} />
<main class="page space-y-4 pt-3" data-testid="ecran-plus">
	<ul class="divide-y rounded-xl border bg-card">
		{#each items as item (item.href)}
			<li>
				<a href={resolve(item.path)} class="flex min-h-14 items-center gap-3 p-3 hover:bg-accent">
					<item.icon class="size-6 shrink-0 text-primary" aria-hidden="true" />
					<span class="flex-1 font-semibold">{item.label}</span>
					<ChevronRight class="size-5 text-muted-foreground" aria-hidden="true" />
				</a>
			</li>
		{/each}
		{#if profile.space !== 'admin'}
			<li>
				<a href={resolve('espace')} class="flex min-h-14 items-center gap-3 p-3 hover:bg-accent">
					<ArrowLeftRight class="size-6 shrink-0 text-primary" aria-hidden="true" />
					<span class="flex-1 font-semibold">{fr.app.switchSpace}</span>
					<ChevronRight class="size-5 text-muted-foreground" aria-hidden="true" />
				</a>
			</li>
		{/if}
		<li>
			<a href={resolve('espace/compte')} class="flex min-h-14 items-center gap-3 p-3 hover:bg-accent">
				<CircleUserRound class="size-6 shrink-0 text-primary" aria-hidden="true" />
				<span class="flex-1 font-semibold">{fr.account.title}</span>
				<ChevronRight class="size-5 text-muted-foreground" aria-hidden="true" />
			</a>
		</li>
	</ul>
	<div class="rounded-xl border bg-card p-1"><LogoutButton class="min-h-14 font-semibold" /></div>
</main>
