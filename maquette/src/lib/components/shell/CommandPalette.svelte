<script lang="ts">
	/**
	 * Ordinateur : recherche globale (Ctrl+K ou ⌘K). Trouve un locataire, un bien ou un écran
	 * et y va au clavier : flèches pour choisir, Entrée pour ouvrir, Échap pour fermer.
	 */
	import { goto } from '$app/navigation';
	import { Building2, CornerDownLeft, Search, User } from '@lucide/svelte';
	import { demo } from '$lib/demo.svelte';
	import { formatFCFA } from '$lib/format';
	import { cn } from '$lib/utils';
	import { allLeaseViews } from '$lib/views';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	let query = $state('');
	let index = $state(0);
	let input = $state<HTMLInputElement | null>(null);

	const normalize = (s: string) =>
		s
			.toLowerCase()
			.normalize('NFD')
			.replace(/[̀-ͯ]/g, '');

	type Result = { group: string; label: string; hint: string; href: string; icon: typeof Search };

	const results = $derived.by((): Result[] => {
		const q = normalize(query.trim());
		const pages: Result[] = demo.profile.nav.map((n) => ({ group: 'Écrans', label: n.label, hint: 'Aller à', href: n.href, icon: n.icon }));
		const tenants: Result[] = allLeaseViews(demo.data).map((v) => ({
			group: 'Locataires',
			label: `${v.tenant.civility} ${v.tenant.name}`,
			hint: `${v.property.name} — ${v.unit.label}${v.balanceDue ? ' · ' + formatFCFA(v.balanceDue) + ' dû' : ''}`,
			href: `/encaisser/${v.lease.id}`,
			icon: User
		}));
		const props: Result[] = demo.data.properties.map((p) => ({
			group: 'Biens',
			label: p.name,
			hint: `${p.district}, ${p.city}`,
			href: `/biens/${p.id}`,
			icon: Building2
		}));
		const all = [...pages, ...tenants, ...props];
		if (!q) return all.slice(0, 8);
		return all.filter((r) => normalize(`${r.label} ${r.hint}`).includes(q)).slice(0, 12);
	});

	$effect(() => {
		if (open) {
			query = '';
			index = 0;
			queueMicrotask(() => input?.focus());
		}
	});
	$effect(() => {
		void query;
		index = 0;
	});

	function go(r: Result | undefined) {
		if (!r) return;
		open = false;
		goto(r.href);
	}

	function onKeydown(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			if (demo.profile.space === 'agency') open = !open;
			return;
		}
		if (!open) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			open = false;
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			index = Math.min(results.length - 1, index + 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			index = Math.max(0, index - 1);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			go(results[index]);
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
	<div class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]" role="presentation" onclick={(e) => e.target === e.currentTarget && (open = false)}>
		<div class="w-full max-w-xl overflow-hidden rounded-2xl border bg-card shadow-2xl" role="dialog" aria-modal="true" aria-label="Recherche">
			<label class="flex items-center gap-3 border-b px-4">
				<Search class="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
				<span class="sr-only">Rechercher</span>
				<input
					bind:this={input}
					bind:value={query}
					class="min-h-14 flex-1 bg-transparent text-lg outline-none placeholder:text-muted-foreground"
					placeholder="Locataire, bien ou écran…"
					role="combobox"
					aria-expanded="true"
					aria-controls="resultats-recherche"
					aria-activedescendant={results[index] ? `resultat-${index}` : undefined}
				/>
				<kbd class="rounded border bg-muted px-1.5 text-sm text-muted-foreground">Échap</kbd>
			</label>
			<ul id="resultats-recherche" role="listbox" class="max-h-[50vh] overflow-y-auto p-2">
				{#each results as r, i (r.group + r.href + r.label)}
					{#if i === 0 || results[i - 1].group !== r.group}
						<li role="presentation" class="px-3 pt-2 pb-1 text-sm font-semibold text-muted-foreground">{r.group}</li>
					{/if}
					<li
						id="resultat-{i}"
						role="option"
						aria-selected={i === index}
						class={cn('flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2', i === index ? 'bg-secondary' : 'hover:bg-accent')}
						onmousemove={() => (index = i)}
						onclick={() => go(r)}
						onkeydown={() => {}}
					>
						<r.icon class="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
						<span class="min-w-0 flex-1">
							<span class="block truncate font-medium">{r.label}</span>
							<span class="block truncate text-sm text-muted-foreground">{r.hint}</span>
						</span>
						{#if i === index}<CornerDownLeft class="size-4 text-muted-foreground" aria-hidden="true" />{/if}
					</li>
				{:else}
					<li class="px-3 py-6 text-center text-muted-foreground">Aucun résultat.</li>
				{/each}
			</ul>
		</div>
	</div>
{/if}
