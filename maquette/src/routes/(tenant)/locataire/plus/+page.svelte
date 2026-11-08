<script lang="ts">
	/** Téléphone : le reste du menu du locataire. */
	import { ChevronRight, History, Info, MessageCircle, Wrench } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';

	const links = [
		{ href: '/locataire/historique', label: 'Mon historique', hint: 'Tous mes baux, toutes agences confondues', icon: History },
		{ href: '/locataire/signalements', label: 'Mes signalements', hint: 'Un problème dans le logement, suivi', icon: Wrench },
		{ href: '/locataire/contact', label: 'Contacter l’agence', hint: 'WhatsApp ou appel', icon: MessageCircle }
	];
</script>

<PageHeader title="Plus" />

<main class="page space-y-4 pt-3">
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
	<p class="flex items-start gap-2 text-base text-muted-foreground">
		<Info class="mt-0.5 size-4 shrink-0" aria-hidden="true" /> Pour donner votre préavis, écrivez à votre agence : le préavis en ligne arrive avec l’espace personnel définitif.
	</p>
</main>
