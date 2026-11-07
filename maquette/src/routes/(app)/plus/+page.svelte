<script lang="ts">
	import { goto } from '$app/navigation';
	import { ChevronRight, ClipboardCheck, Globe, RotateCcw, TriangleAlert, Users } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { demo } from '$lib/demo.svelte';
	import { formatPhone } from '$lib/format';

	let confirming = $state(false);

	/** Les entrées du menu qui n'ont pas d'onglet sur téléphone, selon le profil. */
	const hints: Record<string, { label?: string; hint: string; icon?: typeof Users }> = {
		'/impayes': { hint: 'Relancer par WhatsApp, encaisser', icon: TriangleAlert },
		'/proprietaires': { label: 'Propriétaires et relevés', hint: 'Relevé du mois envoyé par lien' },
		'/encaissements?filtre=a_valider': { label: 'Encaissements à contrôler', hint: 'Espèces des agents, Mobile Money à rapprocher', icon: ClipboardCheck }
	};
	const links = $derived([
		...demo.profile.nav
			.filter((n) => !n.tab && n.href !== '/plus')
			.map((n) => ({ href: n.href, label: hints[n.href]?.label ?? n.label, hint: hints[n.href]?.hint ?? '', icon: hints[n.href]?.icon ?? n.icon })),
		{ href: '/vitrine', label: 'Vitrine publique', hint: 'Les annonces vues par les visiteurs', icon: Globe }
	]);
	const team = [
		{ name: 'Awa Ouédraogo', role: 'Directrice' },
		{ name: 'Salif Kaboré', role: 'Gestionnaire' },
		{ name: 'Ismaël Sana', role: 'Agent de terrain' }
	];

	function reset() {
		demo.reset();
		confirming = false;
		goto('/');
	}
</script>

<PageHeader title={demo.profileId === 'director' ? 'Agence et équipe' : 'Plus'} />

<main class="page space-y-4 pt-3 md:grid md:grid-cols-2 md:items-start md:gap-6 md:space-y-0">
	<div class="space-y-4">
	<ul class="divide-y rounded-xl border bg-card">
		{#each links as l (l.href)}
			<li>
				<a href={l.href} class="flex min-h-16 items-center gap-3 p-3 hover:bg-accent">
					<l.icon class="size-6 shrink-0 text-primary" aria-hidden="true" />
					<div class="flex-1">
						<p class="font-semibold">{l.label}</p>
						<p class="text-base text-muted-foreground">{l.hint}</p>
					</div>
					<ChevronRight class="size-6 text-muted-foreground" aria-hidden="true" />
				</a>
			</li>
		{/each}
	</ul>

	</div>
	<div class="space-y-4">
	<Card.Root>
		<Card.Content class="space-y-1">
			<p class="text-base text-muted-foreground">{demo.profileId === 'landlord' ? 'Bailleur' : 'Agence'}</p>
			<p class="font-semibold">{demo.workspaceName}</p>
			<p class="text-base">{demo.data.agency.address}</p>
			<p class="text-base">{formatPhone(demo.data.agency.phone)}</p>
		</Card.Content>
	</Card.Root>

	{#if demo.profileId === 'director'}
		<Card.Root>
			<Card.Content class="space-y-2">
				<p class="font-semibold">Équipe</p>
				<ul class="divide-y">
					{#each team as m (m.name)}
						<li class="flex items-center justify-between gap-2 py-2"><span>{m.name}</span><span class="text-muted-foreground">{m.role}</span></li>
					{/each}
				</ul>
			</Card.Content>
		</Card.Root>
	{/if}

	<div class="pt-8 md:pt-0">
		{#if confirming}
			<div class="space-y-2 rounded-xl border bg-card p-3" role="alertdialog" aria-labelledby="titre-reset">
				<p id="titre-reset" class="font-medium">Effacer toutes les saisies faites pendant la démo ?</p>
				<div class="grid grid-cols-2 gap-2">
					<Button variant="outline" onclick={() => (confirming = false)}>Annuler</Button>
					<Button variant="destructive" onclick={reset}>Réinitialiser</Button>
				</div>
			</div>
		{:else}
			<Button variant="ghost" class="w-full text-muted-foreground" onclick={() => (confirming = true)}>
				<RotateCcw aria-hidden="true" /> Réinitialiser la démo
			</Button>
		{/if}
		<p class="pt-2 text-center text-base text-muted-foreground">Maquette — données fictives</p>
	</div>
	</div>
</main>
