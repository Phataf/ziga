<script lang="ts">
	import type { Path } from '$app/types';
	import { resolve } from '$app/paths';
	/**
	 * Choix de l'espace (docs/UX.md §2) : une personne peut être membre d'une agence, propriétaire et locataire.
	 * Au lot 01, tous les espaces sont proposés ; à partir du lot 10 ter, seulement ceux de la personne connectée.
	 */
	import { Building2, ChevronRight, House, KeyRound, Lock, Wallet } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { fr } from '#lib/i18n/fr.ts';

	const t = fr.spaceChoice;
	const spaces: { path: Path | `app?profil=${string}`; label: string; hint: string; icon: typeof House; id: string }[] = [
		{ path: 'espace/proprietaire', label: t.owner, hint: t.ownerHint, icon: Building2, id: 'owner' },
		{ path: 'espace/locataire', label: t.tenant, hint: t.tenantHint, icon: KeyRound, id: 'tenant' },
		{ path: 'app?profil=landlord', label: t.landlord, hint: t.landlordHint, icon: House, id: 'landlord' },
		{ path: 'app?profil=manager', label: t.agency, hint: t.agencyHint, icon: Wallet, id: 'agency' }
	];
</script>

<PageHeader title={t.title} subtitle={t.subtitle} />
<main class="page-narrow space-y-4 pt-3 pb-10" data-testid="choix-espace">
	<ul class="space-y-3">
		{#each spaces as s (s.id)}
			<li>
				<a
					href={resolve(s.path)}
					class="flex min-h-20 items-center gap-4 rounded-xl border-2 border-input bg-card p-4 hover:border-primary hover:bg-accent"
					data-testid="espace-{s.id}"
				>
					<span class="flex size-11 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground"
						><s.icon class="size-6" aria-hidden="true" /></span
					>
					<span class="min-w-0 flex-1">
						<span class="block text-lg font-semibold">{s.label}</span>
						<span class="block text-base text-muted-foreground">{s.hint}</span>
					</span>
					<ChevronRight class="size-6 shrink-0 text-muted-foreground" aria-hidden="true" />
				</a>
			</li>
		{/each}
	</ul>
	<p class="flex items-start gap-2 text-base text-muted-foreground"><Lock class="mt-1 size-4 shrink-0" aria-hidden="true" />{t.privacy}</p>
</main>
