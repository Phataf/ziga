<script lang="ts">
	/**
	 * Choix de l'espace (docs/UX.md §2) : les organisations dont la personne est membre (une seule active à la fois),
	 * ses espaces personnels (propriétaire, locataire : seulement ceux que ses fiches liées ouvrent, lot 10 ter), la liaison
	 * de ses fiches et son compte.
	 */
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import {
		Building2,
		ChevronRight,
		CircleUserRound,
		House,
		KeyRound,
		Link2,
		Lock,
		MonitorSmartphone,
		Plus,
		TriangleAlert
	} from '@lucide/svelte';
	import type { MembershipView } from '@ziga/shared/organizations';
	import { ROLE_LABELS } from '@ziga/shared/organizations';
	import LogoutButton from '#lib/components/auth/LogoutButton.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { auth } from '#lib/auth/auth.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { personalSpaces } from '#lib/portals/links.ts';

	const t = fr.spaceChoice;
	const o = fr.organizations;
	const status = { pending: o.pending, verified: o.verified, suspended: o.suspended } as const;

	async function open(m: MembershipView) {
		organizations.select(m.organizationId);
		await goto(resolve('app'));
	}

	// Espaces personnels ouverts à la personne (lot 10 ter) : ses liens d'abord (la propre fiche d'un bailleur particulier
	// s'y lie d'elle-même, réponse 2), puis les espaces que le serveur ouvre ; hors ligne, les deux restent proposés.
	let spaces = $state<{ owner: boolean; tenant: boolean } | null>(null);
	let spacesFailed = $state(false);
	onMount(async () => {
		try {
			await auth.request('GET', '/me/person-links');
			spaces = await auth.request<{ owner: boolean; tenant: boolean }>('GET', '/me/portal');
		} catch {
			spacesFailed = true;
		}
	});
	const shown = $derived(personalSpaces(spaces, spacesFailed));

	const row =
		'flex min-h-20 w-full items-center gap-4 rounded-xl border-2 border-input bg-card p-4 text-left hover:border-primary hover:bg-accent';
	const icon = 'flex size-11 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground';
</script>

<PageHeader title={auth.user ? fr.auth.hello(auth.user.name) : t.title} subtitle={t.subtitle} />
<main class="page-narrow space-y-6 pt-3 pb-10">
	{#if organizations.removedNotice}
		<p role="alert" class="flex items-start gap-2 rounded-lg bg-warning-soft p-3 text-base text-warning-foreground">
			<TriangleAlert class="mt-0.5 size-5 shrink-0" aria-hidden="true" />{o.removed}
		</p>
	{/if}

	<section class="space-y-3" aria-labelledby="titre-gestion">
		<h2 id="titre-gestion" class="text-lg font-semibold">{o.managementSpaces}</h2>
		<ul class="space-y-3" data-testid="espaces-gestion">
			{#each organizations.list as m (m.organizationId)}
				<li>
					<button type="button" class={row} onclick={() => open(m)} data-testid="espace-organisation" data-organisation={m.organizationId}>
						<span class={icon}>
							{#if m.type === 'landlord'}<House class="size-6" aria-hidden="true" />{:else}<Building2
									class="size-6"
									aria-hidden="true"
								/>{/if}
						</span>
						<span class="min-w-0 flex-1">
							<span class="block text-lg font-semibold">{m.type === 'landlord' ? o.mySpaceLandlord : o.mySpaceAgency(m.name)}</span>
							<span class="block text-base text-muted-foreground">
								{m.type === 'landlord' ? m.name : ROLE_LABELS[m.role]} · {status[m.verificationStatus]}
							</span>
						</span>
						<ChevronRight class="size-6 shrink-0 text-muted-foreground" aria-hidden="true" />
					</button>
				</li>
			{:else}
				<li class="text-base text-muted-foreground">{o.none}</li>
			{/each}
			<li>
				<a href={resolve('espace/nouvelle-organisation')} class="{row} border-dashed" data-testid="creer-organisation">
					<span class={icon}><Plus class="size-6" aria-hidden="true" /></span>
					<span class="min-w-0 flex-1 text-lg font-semibold">{o.create}</span>
					<ChevronRight class="size-6 shrink-0 text-muted-foreground" aria-hidden="true" />
				</a>
			</li>
		</ul>
	</section>

	<section class="space-y-3" aria-labelledby="titre-personnels">
		<h2 id="titre-personnels" class="text-lg font-semibold">{o.personalSpaces}</h2>
		<ul class="space-y-3" data-testid="choix-espace">
			{#if shown.includes('owner')}<li>
					<a href={resolve('espace/proprietaire')} class={row} data-testid="espace-owner">
						<span class={icon}><Building2 class="size-6" aria-hidden="true" /></span>
						<span class="min-w-0 flex-1">
							<span class="block text-lg font-semibold">{t.owner}</span>
							<span class="block text-base text-muted-foreground">{t.ownerHint}</span>
						</span>
						<ChevronRight class="size-6 shrink-0 text-muted-foreground" aria-hidden="true" />
					</a>
				</li>{/if}
			{#if shown.includes('tenant')}<li>
					<a href={resolve('espace/locataire')} class={row} data-testid="espace-tenant">
						<span class={icon}><KeyRound class="size-6" aria-hidden="true" /></span>
						<span class="min-w-0 flex-1">
							<span class="block text-lg font-semibold">{t.tenant}</span>
							<span class="block text-base text-muted-foreground">{t.tenantHint}</span>
						</span>
						<ChevronRight class="size-6 shrink-0 text-muted-foreground" aria-hidden="true" />
					</a>
				</li>{/if}
			<li>
				<a href={resolve('espace/liaisons')} class="{row} border-dashed" data-testid="lien-liaisons">
					<span class={icon}><Link2 class="size-6" aria-hidden="true" /></span>
					<span class="min-w-0 flex-1">
						<span class="block text-lg font-semibold">{fr.myLinks.entry}</span>
						<span class="block text-base text-muted-foreground">{fr.myLinks.entryHint}</span>
					</span>
					<ChevronRight class="size-6 shrink-0 text-muted-foreground" aria-hidden="true" />
				</a>
			</li>
		</ul>
	</section>

	<p class="flex items-start gap-2 text-base text-muted-foreground"><Lock class="mt-1 size-4 shrink-0" aria-hidden="true" />{t.privacy}</p>

	<section class="space-y-2" aria-labelledby="titre-compte">
		<h2 id="titre-compte" class="text-lg font-semibold">{fr.auth.account}</h2>
		<div class="divide-y rounded-xl border bg-card p-1">
			<a href={resolve('espace/compte')} class="flex min-h-14 items-center gap-3 px-3 hover:bg-accent" data-testid="lien-compte">
				<CircleUserRound class="size-5 shrink-0" aria-hidden="true" />
				<span class="flex-1">{fr.account.title}</span>
				<ChevronRight class="size-5 text-muted-foreground" aria-hidden="true" />
			</a>
			<a href={resolve('espace/appareils')} class="flex min-h-14 items-center gap-3 px-3 hover:bg-accent" data-testid="lien-appareils">
				<MonitorSmartphone class="size-5 shrink-0" aria-hidden="true" />
				<span class="flex-1">{fr.auth.devices.title}</span>
				<ChevronRight class="size-5 text-muted-foreground" aria-hidden="true" />
			</a>
			<LogoutButton class="min-h-14" />
		</div>
	</section>
</main>
