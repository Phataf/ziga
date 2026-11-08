<script lang="ts">
	/** Compte du propriétaire : ses gestionnaires, ses fiches liées, le journal des lectures, le changement d'espace. */
	import { ArrowLeftRight, BadgeCheck, MessageCircle, Phone, ScrollText } from '@lucide/svelte';
	import OrgTag from '$lib/components/OrgTag.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Button } from '$lib/components/ui/button';
	import { demo } from '$lib/demo.svelte';
	import { personLinks } from '$lib/fixtures-orgs';
	import { formatDate, formatPhone } from '$lib/format';
	import { waLink } from '$lib/whatsapp';

	const person = $derived(demo.ownerPerson);
	const links = $derived(personLinks.filter((l) => l.personId === person.id && l.kind === 'owner'));
</script>

<PageHeader title="Mon compte" subtitle="{person.civility} {person.name} · {formatPhone(person.phone)}, vérifié par SMS" />

<main class="page space-y-4 pt-3 md:grid md:grid-cols-2 md:items-start md:gap-6 md:space-y-0" data-testid="compte-proprietaire">
	<div class="space-y-4">
		{#if demo.spaces.length > 1}
			<Button variant="outline" size="lg" href="/espaces" class="w-full"><ArrowLeftRight aria-hidden="true" /> Changer d’espace</Button>
		{/if}
		<section class="space-y-2" aria-labelledby="titre-gestionnaires">
			<h2 id="titre-gestionnaires" class="text-lg font-semibold">Mes gestionnaires</h2>
			<ul class="space-y-2">
				{#each links as l (l.organizationId)}
					{@const org = demo.orgs[l.organizationId].agency}
					<li class="space-y-2 rounded-xl border bg-card p-4">
						<OrgTag organization={org} />
						{#if org.kind === 'landlord'}
							<p class="text-base">Vous gérez vous-même ces logements, depuis l’espace « Mes logements ».</p>
						{:else}
							<p class="text-base text-muted-foreground">{org.address} · {formatPhone(org.phone)}</p>
							<div class="grid grid-cols-2 gap-2">
								<Button variant="whatsapp" target="_blank" rel="noopener" href={waLink(org.phone, `Bonjour ${org.name}, c’est ${person.civility} ${person.name}.`)}><MessageCircle aria-hidden="true" /> WhatsApp</Button>
								<Button variant="outline" href="tel:{org.phone}"><Phone aria-hidden="true" /> Appeler</Button>
							</div>
						{/if}
						<p class="flex items-center gap-2 text-base text-muted-foreground">
							<BadgeCheck class="size-4 text-primary" aria-hidden="true" /> Lien vérifié par code SMS le {formatDate(l.verifiedOn!)}, accepté le {formatDate(l.acceptedOn!)}
						</p>
					</li>
				{/each}
			</ul>
		</section>
	</div>
	<section class="space-y-2 rounded-xl border bg-card p-4" aria-labelledby="titre-lectures">
		<h2 id="titre-lectures" class="flex items-center gap-2 text-lg font-semibold"><ScrollText class="size-5" aria-hidden="true" /> Lectures journalisées</h2>
		<p class="text-base text-muted-foreground">Votre espace lit chaque organisation séparément, en lecture seule. Chaque lecture est inscrite dans son journal.</p>
		<ul class="divide-y">
			{#each demo.ownerReads as r (r.organizationId)}
				<li class="flex flex-wrap items-center justify-between gap-2 py-2 text-base">
					<span>{demo.orgs[r.organizationId].agency.name}</span>
					<span class="text-muted-foreground">fiche {r.recordId}, le {formatDate(r.at)}</span>
				</li>
			{/each}
		</ul>
	</section>
</main>
