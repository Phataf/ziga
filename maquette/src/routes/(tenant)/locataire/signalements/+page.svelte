<script lang="ts">
	/** Signalements suivis : un problème signalé devient une demande avec un état (reçue, planifiée, faite). */
	import { CircleCheck, Wrench } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import ChoiceGroup from '$lib/components/ui/choice/ChoiceGroup.svelte';
	import { demo, type TenantIssue } from '$lib/demo.svelte';
	import { addDays } from '$lib/fixtures';
	import { formatDate } from '$lib/format';
	import { cn } from '$lib/utils';

	const kinds = ['Plomberie, eau', 'Électricité', 'Serrure, porte', 'Autre'] as const;
	let kind = $state<string>(kinds[0]);
	let details = $state('');
	let sent = $state(false);

	/** Demandes déjà suivies par l'agence (données fictives), puis celles faites pendant la démo. */
	const seeded = $derived<TenantIssue[]>([
		{ id: 's1', kind: 'Plomberie, eau', details: 'Fuite sous le lavabo de la douche', createdOn: addDays(demo.today, -5), status: 'planned', plannedOn: addDays(demo.today, 2), note: 'Plombier de l’agence, le matin' },
		{ id: 's2', kind: 'Électricité', details: 'Prise de la chambre qui ne marche plus', createdOn: addDays(demo.today, -40), status: 'done', plannedOn: addDays(demo.today, -37), note: 'Prise remplacée' }
	]);
	const issues = $derived([...demo.log.issues, ...seeded]);
	const states: { id: TenantIssue['status']; label: string }[] = [
		{ id: 'received', label: 'Reçue' },
		{ id: 'planned', label: 'Planifiée' },
		{ id: 'done', label: 'Faite' }
	];
	const order = { received: 0, planned: 1, done: 2 };

	function submit(e: SubmitEvent) {
		e.preventDefault();
		demo.reportIssue(kind, details.trim());
		details = '';
		sent = true;
	}
</script>

<PageHeader title="Mes signalements" subtitle="Un problème dans le logement, suivi jusqu’à la réparation" />

<main class="page space-y-4 pt-3 lg:grid lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start lg:gap-6 lg:space-y-0" data-testid="signalements">
	<section class="space-y-3" aria-labelledby="titre-demandes">
		<h2 id="titre-demandes" class="text-lg font-semibold">Mes demandes</h2>
		<ul class="space-y-3" data-testid="liste-signalements">
			{#each issues as i (i.id)}
				<li class="space-y-3 rounded-xl border bg-card p-4">
					<div class="flex flex-wrap items-start justify-between gap-2">
						<div class="min-w-0">
							<p class="font-semibold">{i.kind}</p>
							<p class="text-base">{i.details}</p>
							<p class="text-base text-muted-foreground">Signalé le {formatDate(i.createdOn)} à {demo.data.agency.name}</p>
						</div>
						<Badge variant={i.status === 'done' ? 'success' : i.status === 'planned' ? 'info' : 'warning'}>{states[order[i.status]].label}</Badge>
					</div>
					<ol class="grid grid-cols-3 gap-1" aria-label="Avancement">
						{#each states as s (s.id)}
							<li class={cn('rounded-lg px-2 py-1 text-center text-base', order[s.id] <= order[i.status] ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>{s.label}</li>
						{/each}
					</ol>
					{#if i.plannedOn}<p class="text-base">{i.status === 'done' ? 'Fait' : 'Prévu'} le {formatDate(i.plannedOn)}{i.note ? ` : ${i.note}` : ''}.</p>{/if}
				</li>
			{/each}
		</ul>
	</section>

	<form class="space-y-4 rounded-xl border bg-card p-4 md:p-6" onsubmit={submit} aria-labelledby="titre-signaler">
		<h2 id="titre-signaler" class="flex items-center gap-2 text-lg font-semibold"><Wrench class="size-5" aria-hidden="true" /> Signaler un problème</h2>
		{#if sent}
			<p class="flex items-center gap-2 rounded-lg bg-success-soft p-3 font-medium" role="status">
				<CircleCheck class="size-6 text-primary" aria-hidden="true" /> Demande envoyée. Vous suivrez ici son avancement.
			</p>
		{/if}
		<ChoiceGroup legend="Type de problème" name="type" bind:value={kind} options={kinds.map((k) => ({ value: k as string, label: k }))} />
		<label class="block space-y-2">
			<span class="font-semibold">Détails</span>
			<textarea bind:value={details} rows="3" class="w-full rounded-lg border-2 border-input bg-card p-3 outline-none focus-visible:border-ring" placeholder="Ex. : fuite sous l’évier depuis hier" data-testid="details-signalement"></textarea>
		</label>
		<Button type="submit" size="lg" class="w-full" disabled={details.trim().length < 5}>Envoyer la demande</Button>
	</form>
</main>
