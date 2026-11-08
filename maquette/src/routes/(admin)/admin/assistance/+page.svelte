<script lang="ts">
	/**
	 * Accès d'assistance : lecture seule, motivé, limité dans le temps, journalisé et visible par l'organisation.
	 * L'assistance ne se connecte jamais « en tant que » un utilisateur.
	 */
	import { page } from '$app/state';
	import { CircleAlert, Clock, Eye, LifeBuoy } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import ChoiceGroup from '$lib/components/ui/choice/ChoiceGroup.svelte';
	import { demo } from '$lib/demo.svelte';
	import { isAccessActive, platformOrganizations, supportAccessErrors } from '$lib/platform';

	let organizationId = $state(page.url.searchParams.get('organisation') ?? '');
	let reason = $state('');
	let minutes = $state<'30' | '60' | '120'>('30');
	let tried = $state(false);
	const errors = $derived(supportAccessErrors({ organizationId, reason, minutes: Number(minutes) }));
	const orgName = (id: string) => platformOrganizations.find((o) => o.id === id)?.name ?? id;
	const now = new Date();

	function submit(e: SubmitEvent) {
		e.preventDefault();
		tried = true;
		if (errors.length) return;
		demo.openSupportAccess({ organizationId, agent: 'Awa Traoré', reason: reason.trim(), minutes: Number(minutes) }, orgName(organizationId));
		reason = '';
		tried = false;
	}
	const time = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Ouagadougou' });
</script>

<PageHeader title="Accès d’assistance" subtitle="Lecture seule, motivé, limité dans le temps, visible par l’organisation" />

<main class="page space-y-4 pt-3 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start lg:gap-6 lg:space-y-0" data-testid="admin-assistance">
	<form class="space-y-4 rounded-xl border bg-card p-4 md:p-6" onsubmit={submit} aria-labelledby="titre-demande-acces" novalidate>
		<h2 id="titre-demande-acces" class="flex items-center gap-2 text-lg font-semibold"><LifeBuoy class="size-5" aria-hidden="true" /> Ouvrir un accès</h2>
		<label class="block space-y-1">
			<span class="font-semibold">Organisation</span>
			<select bind:value={organizationId} class="min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 outline-none focus-visible:border-ring" data-testid="organisation-acces">
				<option value="">Choisir…</option>
				{#each platformOrganizations as o (o.id)}<option value={o.id}>{o.name}</option>{/each}
			</select>
		</label>
		<label class="block space-y-1">
			<span class="font-semibold">Motif (obligatoire)</span>
			<textarea bind:value={reason} rows="3" class="w-full rounded-lg border-2 border-input bg-card p-3 outline-none focus-visible:border-ring" placeholder="ex. demande de l’agence du 08/11 : relevé d’octobre introuvable" data-testid="motif-acces"></textarea>
		</label>
		<ChoiceGroup legend="Durée" name="duree" bind:value={minutes} columns={3} options={[{ value: '30', label: '30 minutes' }, { value: '60', label: '1 heure' }, { value: '120', label: '2 heures' }]} />
		{#if tried && errors.length}
			<ul class="space-y-1 rounded-lg bg-danger-soft p-3 text-base text-destructive" role="alert">
				{#each errors as e (e)}<li class="flex items-start gap-2"><CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />{e}</li>{/each}
			</ul>
		{/if}
		<p class="text-base text-muted-foreground">Vous lirez avec vos propres droits, sans pouvoir modifier ni vous connecter à la place d’un utilisateur. L’organisation verra l’accès et son motif dans son journal.</p>
		<Button type="submit" size="lg" class="w-full md:w-auto"><Eye aria-hidden="true" /> Ouvrir l’accès en lecture</Button>
	</form>

	<section class="space-y-2" aria-labelledby="titre-acces">
		<h2 id="titre-acces" class="text-lg font-semibold">Accès ouverts</h2>
		<ul class="space-y-2" data-testid="liste-acces">
			{#each demo.log.support as a (a.id)}
				{@const active = isAccessActive(a, now)}
				<li class="space-y-1 rounded-xl border bg-card p-4">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<p class="font-semibold">{orgName(a.organizationId)}</p>
						<Badge variant={active ? 'info' : 'outline'}><Clock aria-hidden="true" />{active ? `Jusqu’à ${time(new Date(new Date(a.startedAt).getTime() + a.minutes * 60000).toISOString())}` : 'Terminé'}</Badge>
					</div>
					<p class="text-base">« {a.reason} »</p>
					<p class="text-base text-muted-foreground">{a.agent} · {a.minutes} minutes · lecture seule</p>
				</li>
			{:else}
				<li class="rounded-xl border bg-card p-4 text-muted-foreground">Aucun accès ouvert aujourd’hui.</li>
			{/each}
		</ul>
	</section>
</main>
