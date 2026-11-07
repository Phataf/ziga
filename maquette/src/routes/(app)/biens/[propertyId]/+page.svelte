<script lang="ts">
	import { page } from '$app/state';
	import { Bed, Check, CircleCheck, Eye, EyeOff, FileText, Globe, MessageCircle, Ruler, Wallet, X } from '@lucide/svelte';
	import PropertyList from '$lib/components/agency/PropertyList.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { ActionMenu } from '$lib/components/ui/menu';
	import { Sheet } from '$lib/components/ui/sheet';
	import PhotoPlaceholder from '$lib/components/PhotoPlaceholder.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { demo } from '$lib/demo.svelte';
	import { device } from '$lib/device.svelte';
	import { formatDate, formatFCFA, formatPhone } from '$lib/format';
	import { unitStatusLabel, unitStatusVariant } from '$lib/labels';
	import { isMandateActive, publicationBlockers } from '$lib/rules';
	import type { Unit } from '$lib/types';
	import { activeLeaseOfUnit, propertyUnits } from '$lib/views';
	import { waLink } from '$lib/whatsapp';

	const property = $derived(demo.data.properties.find((p) => p.id === page.params.propertyId));
	const owner = $derived(property ? demo.data.owners.find((o) => o.id === property.ownerId) : undefined);
	const mandate = $derived(property ? demo.data.mandates.find((m) => m.id === property.mandateId) : undefined);
	const units = $derived(property ? propertyUnits(demo.data, property.id) : []);

	/** Unité dont la feuille de publication est ouverte. */
	let sheetUnitId = $state<string | null>(null);
	let sheetOpen = $state(false);
	$effect(() => {
		if (!sheetOpen) sheetUnitId = null;
	});
	let justPublished = $state(false);
	const sheetUnit = $derived(units.find((u) => u.id === sheetUnitId));

	function checklist(unit: Unit) {
		if (!mandate) return [];
		return [
			{ ok: unit.status === 'free', label: 'Unité libre' },
			{ ok: isMandateActive(mandate, demo.today) && mandate.canPublish, label: 'Mandat actif qui autorise la publication' },
			{ ok: unit.photos >= 3, label: `Au moins 3 photos (${unit.photos})` },
			{ ok: unit.rent > 0, label: `Loyer renseigné (${formatFCFA(unit.rent)})` }
		];
	}

	function openSheet(unitId: string) {
		sheetUnitId = unitId;
		justPublished = false;
		sheetOpen = true;
	}

	function confirmPublish() {
		if (!sheetUnit) return;
		const blockers = demo.publish(sheetUnit.id);
		justPublished = blockers.length === 0;
	}

	function title(u: Unit) {
		return `${u.kind} ${u.rooms} pièce${u.rooms > 1 ? 's' : ''} — ${property?.district ?? ''}`;
	}
</script>

{#if !property || !owner || !mandate}
	<PageHeader title="Bien" back="/biens" backLabel="Biens" />
	<p class="p-4">Bien introuvable.</p>
{:else}
	<div class="page md:pt-2 lg:grid lg:grid-cols-[minmax(17rem,21rem)_minmax(0,1fr)] lg:items-start lg:gap-6 lg:pt-6">
	<!-- Tablette et ordinateur : la liste reste à gauche, on passe d'un bien à l'autre sans revenir en arrière. -->
	{#if device.twoPane}
	<aside class="sticky top-20 max-h-[calc(100dvh-6rem)] overflow-y-auto pr-1" aria-label="Autres biens">
		<PropertyList activeId={property.id} testid="liste-biens-panneau" />
	</aside>
	{/if}

	<div class="min-w-0">
		<PageHeader flush class="-mx-4 md:mx-0" title={property.name} subtitle="{property.district}, {property.city} · {property.kind}" back="/biens" backLabel="Biens">
			{#snippet actions()}
				{#if demo.profileId !== 'field_agent'}
					<div class="hidden gap-2 md:flex">
						<Button variant="outline" href="/proprietaires/{owner!.id}/releve"><FileText aria-hidden="true" /> Relevé du propriétaire</Button>
					</div>
				{/if}
			{/snippet}
		</PageHeader>

	<main class="space-y-4 pt-3 2xl:grid 2xl:grid-cols-[minmax(0,1fr)_20rem] 2xl:items-start 2xl:gap-6 2xl:space-y-0">
		<div class="space-y-4 md:grid md:grid-cols-2 md:gap-4 md:space-y-0 2xl:order-2 2xl:block 2xl:space-y-4">
		<div class="aspect-[400/260] overflow-hidden rounded-xl">
			<PhotoPlaceholder index={+property.id.slice(1)} label={property.kind} />
		</div>

		<Card.Root>
			<Card.Content class="space-y-3">
				<div>
					<p class="text-base text-muted-foreground">Adresse (privée)</p>
					<p>{property.address}, {property.district}, {property.city}</p>
				</div>
				<div class="space-y-2">
					<div>
						<p class="text-base text-muted-foreground">Propriétaire</p>
						<p class="font-medium">{owner.civility} {owner.name}</p>
						<p class="text-base text-muted-foreground">{formatPhone(owner.phone)} · {owner.residence}</p>
					</div>
					{#if demo.profileId !== 'field_agent'}
						<Button variant="outline" class="w-full md:hidden 2xl:flex" href="/proprietaires/{owner.id}/releve">
							<FileText aria-hidden="true" /> Relevé du propriétaire
						</Button>
					{/if}
				</div>
				<div>
					<p class="text-base text-muted-foreground">Mandat de gestion</p>
					<p>
						Du {formatDate(mandate.startDate)} au {formatDate(mandate.endDate)} · commission {mandate.commissionRate} %
					</p>
					<ul class="mt-1 flex flex-wrap gap-1">
						{#each [{ ok: mandate.canPublish, l: 'Publier' }, { ok: mandate.canPhotograph, l: 'Photographier' }, { ok: mandate.canCollect, l: 'Encaisser' }] as a (a.l)}
							<li>
								<Badge variant={a.ok ? 'success' : 'danger'}>
									{#if a.ok}<Check aria-hidden="true" />{:else}<X aria-hidden="true" />{/if}
									{a.l}
								</Badge>
							</li>
						{/each}
					</ul>
				</div>
			</Card.Content>
		</Card.Root>

		</div>

		<section class="space-y-2 2xl:order-1" aria-labelledby="titre-unites">
			<h2 id="titre-unites" class="text-lg font-semibold">Unités ({units.length})</h2>
			<!-- Ordinateur : tableau des unités, actions secondaires regroupées dans un menu. -->
			{#if device.isDesktop}
			<div class="overflow-x-auto rounded-xl border bg-card">
				<table class="data" data-testid="tableau-unites">
					<thead>
						<tr><th>Unité</th><th>Statut</th><th class="text-right">Loyer</th><th>Locataire ou annonce</th><th><span class="sr-only">Actions</span></th></tr>
					</thead>
					<tbody>
						{#each units as u (u.id)}
							{@const lease = activeLeaseOfUnit(demo.data, u.id)}
							{@const tenant = lease ? demo.data.tenants.find((t) => t.id === lease.tenantId) : undefined}
							{@const published = u.visibility === 'published' && u.status === 'free'}
							<tr data-testid="ligne-unite-{u.id}">
								<td>
									<p class="font-semibold">{u.label}</p>
									<p class="text-muted-foreground">{u.kind} · {u.rooms} p. · {u.surface} m²</p>
								</td>
								<td><Badge variant={unitStatusVariant[u.status]}>{unitStatusLabel[u.status]}</Badge></td>
								<td class="text-right font-semibold tabular-nums">{formatFCFA(u.rent)}</td>
								<td>
									{#if tenant}{tenant.civility} {tenant.name}
									{:else if published}<Badge><Globe aria-hidden="true" /> En ligne</Badge>
									{:else}<span class="text-muted-foreground">—</span>{/if}
								</td>
								<td class="w-1 whitespace-nowrap text-right">
									<div class="flex items-center justify-end gap-1">
										{#if u.status === 'rented' && lease}
											<Button variant="outline" href="/encaisser/{lease.id}"><Wallet aria-hidden="true" /> Encaisser</Button>
										{:else if published}
											<Button variant="outline" href="/annonce/{u.id}"><Eye aria-hidden="true" /> Annonce</Button>
										{:else if u.status === 'free'}
											<Button onclick={() => openSheet(u.id)}><Globe aria-hidden="true" /> Publier</Button>
										{/if}
										<ActionMenu
											label="Actions pour {u.label}"
											actions={[
												...(published ? [{ label: 'Retirer l’annonce', icon: EyeOff, onclick: () => demo.unpublish(u.id) }] : []),
												...(lease ? [{ label: 'Encaisser', icon: Wallet, href: `/encaisser/${lease.id}` }] : []),
												{ label: 'Relevé du propriétaire', icon: FileText, href: `/proprietaires/${owner.id}/releve` }
											]}
										/>
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{:else}
			<div class="grid grid-cols-1 gap-2 md:grid-cols-2">
			{#each units as u (u.id)}
				{@const lease = activeLeaseOfUnit(demo.data, u.id)}
				{@const tenant = lease ? demo.data.tenants.find((t) => t.id === lease.tenantId) : undefined}
				{@const published = u.visibility === 'published' && u.status === 'free'}
				<Card.Root data-testid="unite-{u.id}">
					<Card.Content class="space-y-2">
						<div class="flex items-start justify-between gap-2">
							<div>
								<p class="font-semibold">{u.label}</p>
								<p class="flex flex-wrap items-center gap-x-3 text-base text-muted-foreground">
									<span class="flex items-center gap-1"><Bed class="size-4" aria-hidden="true" />{u.rooms} p.</span>
									<span class="flex items-center gap-1"><Ruler class="size-4" aria-hidden="true" />{u.surface} m²</span>
									<span>{formatFCFA(u.rent)}/mois</span>
								</p>
							</div>
							<div class="flex flex-col items-end gap-1">
								<Badge variant={unitStatusVariant[u.status]}>{unitStatusLabel[u.status]}</Badge>
								{#if published}<Badge variant="default"><Globe aria-hidden="true" /> Publiée</Badge>{/if}
							</div>
						</div>

						{#if u.status === 'rented' && tenant && lease}
							<div class="flex items-center justify-between gap-2 rounded-lg bg-muted p-2">
								<p class="min-w-0 truncate text-base">Locataire : {tenant.civility} {tenant.name}</p>
								<Button variant="outline" href="/encaisser/{lease.id}"><Wallet aria-hidden="true" /> Encaisser</Button>
							</div>
						{:else if published}
							<div class="grid grid-cols-2 gap-2">
								<Button variant="secondary" href="/annonce/{u.id}"><Eye aria-hidden="true" /> Voir l’annonce</Button>
								<Button variant="outline" onclick={() => demo.unpublish(u.id)}><EyeOff aria-hidden="true" /> Retirer</Button>
							</div>
						{:else if u.status === 'free'}
							<Button class="w-full" onclick={() => openSheet(u.id)}><Globe aria-hidden="true" /> Publier</Button>
						{:else}
							<p class="text-base text-muted-foreground">Réservée : publication impossible tant que la réservation est en cours.</p>
						{/if}
					</Card.Content>
				</Card.Root>
			{/each}
			</div>
			{/if}
		</section>
	</main>
	</div>
	</div>

	{#if sheetUnit}
		{@const items = checklist(sheetUnit)}
		{@const blockers = publicationBlockers(sheetUnit, mandate, demo.today)}
		<Sheet bind:open={sheetOpen} labelledby="titre-publier">
			<div class="space-y-4">
				{#if justPublished}
					<div class="space-y-2 text-center" role="status">
						<CircleCheck class="mx-auto size-12 text-primary" aria-hidden="true" />
						<h2 id="titre-publier" class="text-xl font-bold">Annonce en ligne</h2>
						<p class="text-base text-muted-foreground">{title(sheetUnit)} est visible sur la vitrine. Elle sera retirée dès que l’unité sera louée.</p>
					</div>
					<div class="space-y-2">
						<Button href="/annonce/{sheetUnit.id}" size="lg" class="w-full"><Eye aria-hidden="true" /> Voir l’annonce</Button>
						<Button
							href={waLink('', `${title(sheetUnit)} à ${formatFCFA(sheetUnit.rent)}/mois — ${page.url.origin}/annonce/${sheetUnit.id}`)}
							target="_blank"
							rel="noopener"
							variant="whatsapp"
							class="w-full"
						>
							<MessageCircle aria-hidden="true" /> Partager sur WhatsApp
						</Button>
						<Button variant="ghost" class="w-full" onclick={() => (sheetOpen = false)}>Fermer</Button>
					</div>
				{:else}
					<div>
						<h2 id="titre-publier" class="text-xl font-bold">Publier {sheetUnit.label}</h2>
						<p class="text-base text-muted-foreground">{title(sheetUnit)} · {formatFCFA(sheetUnit.rent)}/mois</p>
					</div>
					<ul class="space-y-2" aria-label="Conditions de publication">
						{#each items as it (it.label)}
							<li class="flex items-center gap-2">
								{#if it.ok}
									<CircleCheck class="size-6 shrink-0 text-primary" aria-hidden="true" />
									<span>{it.label}</span>
								{:else}
									<X class="size-6 shrink-0 text-destructive" aria-hidden="true" />
									<span class="text-destructive">{it.label}</span>
								{/if}
							</li>
						{/each}
					</ul>
					{#if blockers.length}
						<p class="rounded-lg bg-danger-soft p-3 text-base text-destructive" data-testid="refus-publication">
							Publication impossible : {blockers.join(' ')}
						</p>
					{/if}
					<p class="text-base text-muted-foreground">
						Seuls le type, le quartier, le prix, les photos et l’agence seront visibles. L’adresse exacte et le propriétaire restent privés.
					</p>
					<div class="grid grid-cols-2 gap-2">
						<Button variant="outline" onclick={() => (sheetOpen = false)}>Annuler</Button>
						<Button onclick={confirmPublish} disabled={blockers.length > 0}><Globe aria-hidden="true" /> Publier</Button>
					</div>
				{/if}
			</div>
		</Sheet>
	{/if}
{/if}
