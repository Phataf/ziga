<script lang="ts">
	import { ChevronRight, Wrench } from '@lucide/svelte';
	import AgencyContact from '$lib/components/AgencyContact.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { demo } from '$lib/demo.svelte';
	import { leaseView } from '$lib/views';

	const v = $derived(leaseView(demo.data, demo.tenantLeaseId)!);
</script>

<PageHeader title="Contacter l’agence" subtitle="Une question, un problème dans le logement" />

<main class="page space-y-4 pt-3 md:grid md:grid-cols-[minmax(0,1fr)_22rem] md:items-start md:gap-6 md:space-y-0">
	<a href="/locataire/signalements" class="flex min-h-16 items-center gap-3 rounded-xl border bg-card p-4 hover:bg-accent">
		<Wrench class="size-6 shrink-0 text-primary" aria-hidden="true" />
		<span class="flex-1">
			<span class="block font-semibold">Signaler un problème dans le logement</span>
			<span class="block text-base text-muted-foreground">Votre demande est suivie : reçue, planifiée, faite.</span>
		</span>
		<ChevronRight class="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
	</a>
	<AgencyContact message="Bonjour, c’est {v.tenant.civility} {v.tenant.name} ({v.property.name} — {v.unit.label})." />
</main>
