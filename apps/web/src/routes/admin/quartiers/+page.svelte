<script lang="ts">
	/**
	 * Back-office : quartiers (lot 07). Référentiel des communes et quartiers, avec le point central et la vérification
	 * sur place (© les contributeurs d'OpenStreetMap). Ajouter un quartier et corriger un point : super administrateur et
	 * assistance (l'API décide) ; chaque action est inscrite au journal de la plateforme. Un quartier ne se supprime
	 * jamais : des biens le référencent. Cartes sur téléphone, tableau sur ordinateur.
	 */
	import { onMount } from 'svelte';
	import { Pencil, Plus, Search } from '@lucide/svelte';
	import type { CommuneView, NeighborhoodView } from '@ziga/shared/geography';
	import { placeNameKey } from '@ziga/shared/geography';
	import { newId } from '@ziga/shared/ids';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import CheckField from '#lib/components/owners/CheckField.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import Sheet from '#lib/components/ui/sheet/Sheet.svelte';
	import { adminCall, allowed } from '#lib/admin/admin.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';

	const t = fr.admin.neighborhoods;
	const select = 'min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 text-base';
	const canManage = allowed('geography.manage');

	let communes = $state<CommuneView[]>([]);
	let neighborhoods = $state<NeighborhoodView[]>([]);
	let q = $state('');
	let commune = $state('');
	let message = $state<string | null>(null);

	// Panneau : ajout (editing = null) ou correction.
	let open = $state(false);
	let editing = $state<NeighborhoodView | null>(null);
	let formCommune = $state('ouagadougou');
	let name = $state('');
	let lat = $state('');
	let lng = $state('');
	let verified = $state(false);
	let formMessage = $state<string | null>(null);
	let busy = $state(false);

	async function load() {
		try {
			const r = await adminCall<{ communes: CommuneView[]; neighborhoods: NeighborhoodView[] }>('GET', '/geography');
			communes = r.communes;
			neighborhoods = r.neighborhoods;
		} catch (error) {
			message = messageOf(error);
		}
	}
	onMount(load);

	const shown = $derived(
		neighborhoods.filter((n) => (!commune || n.communeId === commune) && (!q.trim() || placeNameKey(n.name).includes(placeNameKey(q))))
	);
	const communeName = (id: string) => communes.find((c) => c.id === id)?.name ?? id;
	const point = (n: NeighborhoodView) => (n.lat !== null && n.lng !== null ? `${n.lat.toFixed(5)}, ${n.lng.toFixed(5)}` : t.noPoint);

	function openForm(n: NeighborhoodView | null) {
		editing = n;
		formCommune = n?.communeId ?? (commune || 'ouagadougou');
		name = n?.name ?? '';
		lat = n?.lat !== null && n?.lat !== undefined ? String(n.lat) : '';
		lng = n?.lng !== null && n?.lng !== undefined ? String(n.lng) : '';
		verified = n?.verified ?? false;
		formMessage = null;
		open = true;
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		formMessage = null;
		const p = lat.trim() && lng.trim() ? { lat: Number(lat.replace(',', '.')), lng: Number(lng.replace(',', '.')) } : null;
		busy = true;
		try {
			if (editing) {
				await adminCall('PATCH', `/neighborhoods/${editing.id}`, { name, point: p, verified });
			} else {
				await adminCall('POST', '/neighborhoods', { id: newId(), communeId: formCommune, name, point: p });
			}
			open = false;
			await load();
		} catch (error) {
			formMessage = messageOf(error);
		} finally {
			busy = false;
		}
	}
</script>

<PageHeader title={t.title} subtitle={t.subtitle}>
	{#snippet actions()}
		{#if canManage && !device.isPhone}<Button onclick={() => openForm(null)}><Plus aria-hidden="true" />{t.add}</Button>{/if}
	{/snippet}
</PageHeader>

<main class="page space-y-4 pt-3 pb-10" data-testid="admin-quartiers">
	<FormAlert {message} />
	{#if !canManage}<FormAlert message={t.readOnly} tone="info" />{/if}
	{#if canManage && device.isPhone}<Button size="lg" class="w-full" onclick={() => openForm(null)}
			><Plus aria-hidden="true" />{t.add}</Button
		>{/if}
	<div class="grid gap-3 sm:grid-cols-2">
		<div class="relative">
			<Search class="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
			<Input type="search" bind:value={q} placeholder={t.search} aria-label={t.search} class="pl-10" />
		</div>
		<select bind:value={commune} class={select} aria-label={t.commune}>
			<option value="">{fr.admin.all}</option>
			{#each communes as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
		</select>
	</div>
	<p class="text-base text-muted-foreground">{t.count(shown.length)}</p>
	{#if device.isDesktop}
		<div class="overflow-x-auto rounded-xl border bg-card">
			<table class="w-full text-left text-base">
				<thead class="border-b text-muted-foreground">
					<tr>
						<th class="px-4 py-3 font-medium">{t.name}</th>
						<th class="px-4 py-3 font-medium">{t.commune}</th>
						<th class="px-4 py-3 font-medium">{t.point}</th>
						<th class="px-4 py-3 font-medium">{t.verified}</th>
						{#if canManage}<th class="px-4 py-3 font-medium"><span class="sr-only">{t.edit}</span></th>{/if}
					</tr>
				</thead>
				<tbody class="divide-y">
					{#each shown as n (n.id)}
						<tr data-testid="quartier">
							<td class="px-4 py-3 font-medium">{n.name}</td>
							<td class="px-4 py-3">{communeName(n.communeId)}</td>
							<td class="px-4 py-3 tabular-nums">{point(n)}</td>
							<td class="px-4 py-3"><Badge variant={n.verified ? 'success' : 'secondary'}>{n.verified ? t.yes : t.no}</Badge></td>
							{#if canManage}<td class="px-4 py-3"
									><Button variant="outline" onclick={() => openForm(n)}><Pencil aria-hidden="true" />{t.edit}</Button></td
								>{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<ul class="space-y-3">
			{#each shown as n (n.id)}
				<li class="space-y-2 rounded-xl border bg-card p-4" data-testid="quartier">
					<p class="flex flex-wrap items-center justify-between gap-2">
						<span class="font-semibold">{n.name}</span>
						<Badge variant={n.verified ? 'success' : 'secondary'}>{t.verified} : {n.verified ? t.yes : t.no}</Badge>
					</p>
					<p class="text-base text-muted-foreground">{communeName(n.communeId)} · {point(n)}</p>
					{#if canManage}<Button variant="outline" onclick={() => openForm(n)}><Pencil aria-hidden="true" />{t.edit}</Button>{/if}
				</li>
			{/each}
		</ul>
	{/if}
</main>

<Sheet bind:open labelledby="titre-quartier">
	<form class="space-y-4 p-4" onsubmit={save} novalidate data-testid="formulaire-quartier">
		<h2 id="titre-quartier" class="text-lg font-semibold">{editing ? `${t.edit} · ${editing.name}` : t.add}</h2>
		<FormAlert message={formMessage} />
		{#if !editing}
			<div class="space-y-1">
				<label for="quartier-commune" class="block font-medium">{t.commune}</label>
				<select id="quartier-commune" bind:value={formCommune} class={select}>
					{#each communes as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
				</select>
			</div>
		{/if}
		<div class="space-y-1">
			<label for="quartier-nom" class="block font-medium">{t.name}</label>
			<Input id="quartier-nom" bind:value={name} />
		</div>
		<div class="grid gap-3 sm:grid-cols-2">
			<div class="space-y-1">
				<label for="quartier-lat" class="block font-medium">{t.lat}</label>
				<Input id="quartier-lat" inputmode="decimal" bind:value={lat} />
			</div>
			<div class="space-y-1">
				<label for="quartier-lng" class="block font-medium">{t.lng}</label>
				<Input id="quartier-lng" inputmode="decimal" bind:value={lng} />
			</div>
		</div>
		{#if editing}<CheckField bind:checked={verified} label={t.verified} />{/if}
		<div class="flex flex-wrap gap-2">
			<Button type="submit" disabled={busy}>{t.save}</Button>
			<Button type="button" variant="outline" onclick={() => (open = false)}>{t.cancel}</Button>
		</div>
	</form>
</Sheet>
