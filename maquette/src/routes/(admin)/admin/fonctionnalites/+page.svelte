<script lang="ts">
	/**
	 * Interrupteurs (docs/FEATURE-FLAGS.md) : mode global à trois positions, exceptions par organisation.
	 * Une action qui touche toutes les organisations a sa couleur d'alerte, demande un motif et une confirmation
	 * qui affiche le nombre d'organisations touchées. Chaque changement écrit une ligne au journal.
	 */
	import { Plus, TriangleAlert } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import ChoiceGroup from '$lib/components/ui/choice/ChoiceGroup.svelte';
	import { Input } from '$lib/components/ui/input';
	import { Sheet } from '$lib/components/ui/sheet';
	import { demo } from '$lib/demo.svelte';
	import { formatDate } from '$lib/format';
	import { affectedByCut, modeLabel, plans, platformOrganizations, resolveFeature, type GlobalMode } from '$lib/platform';
	import { cn } from '$lib/utils';

	const modes: GlobalMode[] = ['disabled', 'restricted', 'enabled'];

	// Changement de mode global : confirmation avec motif.
	let pending = $state<{ key: string; mode: GlobalMode } | null>(null);
	let confirmOpen = $state(false);
	let reason = $state('');
	const pendingFeature = $derived(pending ? demo.features.find((f) => f.key === pending!.key) : undefined);
	/** Organisations qui ont la fonctionnalité aujourd'hui et ne l'auraient plus. */
	const losing = $derived(
		pendingFeature && pending
			? platformOrganizations.filter(
					(o) => resolveFeature(pendingFeature, o, demo.overrides, demo.today).enabled && !resolveFeature({ ...pendingFeature, mode: pending!.mode }, o, demo.overrides, demo.today).enabled
				).length
			: 0
	);

	function ask(key: string, mode: GlobalMode) {
		pending = { key, mode };
		reason = '';
		confirmOpen = true;
	}
	function confirm() {
		if (!pending) return;
		demo.setFeatureMode(pending.key, pending.mode, reason.trim());
		confirmOpen = false;
	}

	// Ajout d'une exception pour une organisation.
	let exKey = $state('listings.featured');
	let exOrg = $state('agency-demo');
	let exValue = $state<'yes' | 'no'>('yes');
	let exReason = $state('');
	let exEnd = $state('');
	function addException(e: SubmitEvent) {
		e.preventDefault();
		const org = platformOrganizations.find((o) => o.id === exOrg)!;
		demo.addOverride({ key: exKey, organizationId: exOrg, value: exValue === 'yes', reason: exReason.trim(), endsOn: exEnd || undefined }, org.name);
		exReason = '';
	}
	const orgName = (id: string) => platformOrganizations.find((o) => o.id === id)?.name ?? id;
</script>

<PageHeader title="Fonctionnalités" subtitle="Couper, ouvrir à tous ou ouvrir sur liste ; exceptions par organisation" />

<main class="page space-y-5 pt-3" data-testid="admin-fonctionnalites">
	<ul class="space-y-2">
		{#each demo.features as f (f.key)}
			{@const count = demo.overrides.filter((o) => o.key === f.key).length}
			{@const access = affectedByCut(f, platformOrganizations, demo.overrides, demo.today)}
			<li class="flex flex-col gap-3 rounded-xl border bg-card p-4 xl:flex-row xl:items-center" data-testid="interrupteur-{f.key}">
				<div class="min-w-0 flex-1">
					<p class="font-semibold">{f.label}</p>
					<p class="text-base text-muted-foreground">
						<code class="text-sm">{f.key}</code> · {f.plans.length ? `formules ${f.plans.map((p) => plans.find((x) => x.id === p)!.label).join(', ')}` : 'socle, sans formule'}
						· {count} exception{count > 1 ? 's' : ''} · {access === 0 ? 'aucune organisation n’y a accès' : access === 1 ? '1 organisation y a accès' : `${access} organisations y ont accès`}
					</p>
				</div>
				<div class="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1" role="group" aria-label="Mode global de {f.key}">
					{#each modes as m (m)}
						<button
							type="button"
							class={cn('min-h-11 rounded-md px-2 text-base font-medium', f.mode === m ? (m === 'disabled' ? 'bg-destructive text-destructive-foreground' : 'bg-card shadow-sm') : 'text-muted-foreground hover:bg-card/60')}
							aria-pressed={f.mode === m}
							onclick={() => f.mode !== m && ask(f.key, m)}
						>
							{modeLabel[m]}
						</button>
					{/each}
				</div>
			</li>
		{/each}
	</ul>

	<section class="space-y-3" aria-labelledby="titre-exceptions">
		<h2 id="titre-exceptions" class="text-lg font-semibold">Exceptions par organisation</h2>
		<ul class="divide-y rounded-xl border bg-card" data-testid="exceptions">
			{#each demo.overrides as o (o.id)}
				<li class="flex flex-wrap items-center gap-2 px-4 py-3">
					<code class="text-sm">{o.key}</code>
					<span class="font-medium">{orgName(o.organizationId)}</span>
					<Badge variant={o.value ? 'success' : 'outline'}>{o.value ? 'Forcée à oui' : 'Forcée à non'}</Badge>
					<span class="text-base text-muted-foreground">« {o.reason} »{o.endsOn ? ` · jusqu’au ${formatDate(o.endsOn)}` : ''}</span>
				</li>
			{/each}
		</ul>
		<form class="space-y-4 rounded-xl border bg-card p-4 md:p-6" onsubmit={addException} aria-label="Ajouter une exception">
			<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
				<label class="block space-y-1">
					<span class="font-semibold">Fonctionnalité</span>
					<select bind:value={exKey} class="min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 outline-none focus-visible:border-ring">
						{#each demo.features as f (f.key)}<option value={f.key}>{f.key}</option>{/each}
					</select>
				</label>
				<label class="block space-y-1">
					<span class="font-semibold">Organisation</span>
					<select bind:value={exOrg} class="min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 outline-none focus-visible:border-ring">
						{#each platformOrganizations as o (o.id)}<option value={o.id}>{o.name}</option>{/each}
					</select>
				</label>
			</div>
			<ChoiceGroup legend="Valeur" name="valeur" bind:value={exValue} options={[{ value: 'yes', label: 'Forcer à oui' }, { value: 'no', label: 'Forcer à non' }]} />
			<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
				<label class="block space-y-1"><span class="font-semibold">Motif (obligatoire)</span><Input bind:value={exReason} placeholder="ex. geste commercial" /></label>
				<label class="block space-y-1"><span class="font-semibold">Date de fin (facultative)</span><Input type="date" bind:value={exEnd} /></label>
			</div>
			<Button type="submit" disabled={exReason.trim().length < 5}><Plus aria-hidden="true" /> Ajouter l’exception</Button>
		</form>
	</section>
</main>

{#if pending && pendingFeature}
	<Sheet bind:open={confirmOpen} labelledby="titre-confirmer-interrupteur">
		<div class="space-y-4">
			<div class="space-y-2 rounded-lg border-2 border-destructive bg-danger-soft p-3 text-destructive" role="alert">
				<p class="flex items-center gap-2 font-semibold"><TriangleAlert class="size-5" aria-hidden="true" /> Action sur toutes les organisations</p>
				<p class="text-base">
					{pendingFeature.key} : {modeLabel[pendingFeature.mode].toLowerCase()} → <strong>{modeLabel[pending.mode].toLowerCase()}</strong>.
					{losing ? `${losing} organisation${losing > 1 ? 's' : ''} perdr${losing > 1 ? 'ont' : 'a'} l’accès.` : 'Aucune organisation ne perd l’accès.'}
				</p>
			</div>
			<h2 id="titre-confirmer-interrupteur" class="text-xl font-bold">Confirmer le changement</h2>
			<p class="text-base text-muted-foreground">Aucune donnée n’est supprimée ; un paiement déjà initié est encore traité. Le changement est inscrit au journal.</p>
			<label class="block space-y-1"><span class="font-semibold">Motif (obligatoire)</span><Input bind:value={reason} data-testid="motif-interrupteur" /></label>
			<div class="grid grid-cols-2 gap-2">
				<Button variant="outline" onclick={() => (confirmOpen = false)}>Annuler</Button>
				<Button variant="destructive" disabled={reason.trim().length < 5} onclick={confirm}>Confirmer</Button>
			</div>
		</div>
	</Sheet>
{/if}
