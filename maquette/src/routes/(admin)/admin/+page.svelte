<script lang="ts">
	/**
	 * Organisations (back-office) : compte, formule, abonnement et état effectif des fonctionnalités, avec la raison.
	 * La plateforme ne voit ni les baux ni les paiements d'une organisation ; seul un accès d'assistance motivé l'y autorise.
	 */
	import { BadgeCheck, Building2, House, LifeBuoy } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Sheet } from '$lib/components/ui/sheet';
	import { demo } from '$lib/demo.svelte';
	import { device } from '$lib/device.svelte';
	import { formatDate } from '$lib/format';
	import { plans, platformOrganizations, resolveFeature, subscriptionLabel, type PlatformOrganization } from '$lib/platform';

	let openId = $state<string | null>(null);
	let sheetOpen = $state(false);
	const chosen = $derived(platformOrganizations.find((o) => o.id === openId));
	const planLabel = (o: PlatformOrganization) => plans.find((p) => p.id === o.plan)!.label;
	const unitsOf = (o: PlatformOrganization) => demo.orgs[o.id]?.units.length ?? 0;

	function open(id: string) {
		openId = id;
		sheetOpen = true;
	}
</script>

<PageHeader title="Organisations" subtitle="{platformOrganizations.length} organisations : agences et bailleurs particuliers" />

<main class="page space-y-4 pt-3" data-testid="admin-organisations">
	{#if device.isPhone}
		<ul class="space-y-2">
			{#each platformOrganizations as o (o.id)}
				<li>
					<button type="button" class="w-full space-y-1 rounded-xl border bg-card p-4 text-left hover:bg-accent" onclick={() => open(o.id)} data-testid="organisation-{o.id}">
						<p class="flex items-center gap-2 font-semibold">{o.name}{#if o.verified}<BadgeCheck class="size-4 text-primary" aria-label="vérifiée" />{/if}</p>
						<p class="text-base text-muted-foreground">{o.kind === 'agency' ? 'Agence' : 'Bailleur particulier'} · {planLabel(o)} · {unitsOf(o)} unités</p>
						<Badge variant={o.subscription.status === 'reminder' ? 'warning' : 'success'}>{subscriptionLabel[o.subscription.status]}</Badge>
					</button>
				</li>
			{/each}
		</ul>
	{:else}
		<div class="overflow-x-auto rounded-xl border bg-card">
			<table class="data">
				<thead><tr><th>Organisation</th><th>Type</th><th>Formule</th><th class="text-right">Unités</th><th class="text-right">Membres</th><th>Abonnement</th><th><span class="sr-only">Action</span></th></tr></thead>
				<tbody>
					{#each platformOrganizations as o (o.id)}
						<tr>
							<td><span class="flex items-center gap-2 font-semibold">{o.name}{#if o.verified}<BadgeCheck class="size-4 text-primary" aria-label="vérifiée" />{/if}</span><span class="text-muted-foreground">depuis le {formatDate(o.since)}</span></td>
							<td><span class="flex items-center gap-2">{#if o.kind === 'agency'}<Building2 class="size-4" aria-hidden="true" /> Agence{:else}<House class="size-4" aria-hidden="true" /> Bailleur particulier{/if}</span></td>
							<td>{planLabel(o)}</td>
							<td class="text-right tabular-nums">{unitsOf(o)}</td>
							<td class="text-right tabular-nums">{o.members}</td>
							<td><Badge variant={o.subscription.status === 'reminder' ? 'warning' : 'success'}>{subscriptionLabel[o.subscription.status]}</Badge></td>
							<td class="text-right"><Button variant="outline" onclick={() => open(o.id)} data-testid="organisation-{o.id}">Ouvrir</Button></td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
	<p class="text-base text-muted-foreground">La plateforme voit le compte de chaque organisation, jamais ses baux, ses locataires ni ses paiements.</p>
</main>

{#if chosen}
	<Sheet bind:open={sheetOpen} labelledby="titre-organisation" side="right">
		<div class="space-y-4">
			<div class="pr-10">
				<h2 id="titre-organisation" class="text-xl font-bold">{chosen.name}</h2>
				<p class="text-base text-muted-foreground">{chosen.kind === 'agency' ? 'Agence' : 'Bailleur particulier'} · formule {planLabel(chosen)} · {chosen.members} membre{chosen.members > 1 ? 's' : ''}</p>
			</div>
			<section class="space-y-2" aria-labelledby="titre-fonctions-org">
				<h3 id="titre-fonctions-org" class="font-semibold">Fonctionnalités : état effectif et raison</h3>
				<ul class="divide-y rounded-lg border" data-testid="etat-fonctionnalites">
					{#each demo.features as f (f.key)}
						{@const r = resolveFeature(f, chosen, demo.overrides, demo.today)}
						<li class="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
							<span class="text-base"><code class="text-sm">{f.key}</code></span>
							<Badge variant={r.enabled ? 'success' : 'outline'}>{r.reason}</Badge>
						</li>
					{/each}
				</ul>
			</section>
			<Button href="/admin/assistance?organisation={chosen.id}" variant="outline" class="w-full"><LifeBuoy aria-hidden="true" /> Demander un accès d’assistance</Button>
		</div>
	</Sheet>
{/if}
