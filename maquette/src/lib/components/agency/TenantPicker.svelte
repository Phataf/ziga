<script lang="ts">
	/** Étape 1 de l'encaissement : trouver le locataire. Colonne de gauche sur tablette et ordinateur. */
	import { Search } from '@lucide/svelte';
	import { Input } from '$lib/components/ui/input';
	import { demo } from '$lib/demo.svelte';
	import { formatDate, formatFCFA } from '$lib/format';
	import { cn } from '$lib/utils';
	import { collectList } from '$lib/views';

	let { activeId, testid = 'liste-locataires', autofocus = false }: { activeId?: string; testid?: string; autofocus?: boolean } = $props();

	let query = $state('');
	let field = $state<HTMLInputElement | null>(null);

	$effect(() => {
		// Sur ordinateur, le curseur est prêt dans la recherche : on tape le nom, Entrée, c'est parti.
		if (autofocus && window.matchMedia('(min-width: 80rem)').matches) field?.focus();
	});

	const normalize = (s: string) =>
		s
			.toLowerCase()
			.normalize('NFD')
			.replace(/[̀-ͯ]/g, '');

	const list = $derived.by(() => {
		const q = normalize(query.trim());
		const all = collectList(demo.data);
		if (!q) return all;
		return all.filter((v) => normalize(`${v.tenant.name} ${v.unit.label} ${v.property.name} ${v.property.district}`).includes(q));
	});
</script>

<div class="space-y-3">
	<label class="relative block">
		<span class="sr-only">Chercher un locataire</span>
		<Search class="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
		<Input
			type="search"
			placeholder="Nom, logement ou quartier"
			class="pl-10"
			bind:value={query}
			bind:ref={field}
			onkeydown={(e) => {
				if (e.key === 'Enter' && list[0]) (document.querySelector<HTMLAnchorElement>(`[data-testid="${testid}"] a`))?.click();
			}}
		/>
	</label>

	<ul class="space-y-2" data-testid={testid}>
		{#each list as v (v.lease.id)}
			{@const active = v.lease.id === activeId}
			<li>
				<a
					href="/encaisser/{v.lease.id}"
					aria-current={active ? 'page' : undefined}
					class={cn(
						'flex min-h-16 items-center gap-3 rounded-xl border bg-card p-3 hover:bg-accent active:bg-accent',
						active && 'border-primary bg-secondary ring-1 ring-primary'
					)}
				>
					<div class="min-w-0 flex-1">
						<p class="truncate font-semibold">{v.tenant.civility} {v.tenant.name}</p>
						<p class="truncate text-base text-muted-foreground">{v.property.name} — {v.unit.label}</p>
					</div>
					<div class="shrink-0 text-right">
						{#if v.balanceDue > 0}
							<p class="font-semibold {v.overdueAmount > 0 ? 'text-destructive' : ''}">{formatFCFA(v.balanceDue)}</p>
							<p class="text-base text-muted-foreground">{v.overdueAmount > 0 ? 'en retard' : 'dû aujourd’hui'}</p>
						{:else}
							<p class="font-semibold text-primary">À jour</p>
							{#if v.nextDue}<p class="text-base text-muted-foreground">le {formatDate(v.nextDue.dueDate).slice(0, 5)}</p>{/if}
						{/if}
					</div>
				</a>
			</li>
		{:else}
			<li class="rounded-xl border bg-card p-4 text-base text-muted-foreground">Aucun locataire ne correspond.</li>
		{/each}
	</ul>
</div>
