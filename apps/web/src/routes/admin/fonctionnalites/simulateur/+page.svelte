<script lang="ts">
	/** Simulateur (lot 04, §7.4) : une organisation et une personne ; l'état de chaque clé et l'étape qui a décidé. */
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { FEATURES_BY_KEY } from '@ziga/shared/features';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { adminCall } from '#lib/admin/admin.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';

	const t = fr.admin.simulator;
	let orgs = $state<{ id: string; name: string }[]>([]);
	let people = $state<{ id: string; name: string; phone: string }[]>([]);
	let organizationId = $state(page.url.searchParams.get('organisation') ?? '');
	let userId = $state(page.url.searchParams.get('personne') ?? '');
	let personQuery = $state('');
	let result = $state<Record<string, { enabled: boolean; stepNumber: number | null; reason: string }> | null>(null);
	let message = $state<string | null>(null);

	onMount(async () => {
		try {
			orgs = await adminCall<{ id: string; name: string }[]>('GET', '/organizations');
		} catch (error) {
			message = messageOf(error);
		}
	});

	async function searchPeople() {
		people = personQuery.trim()
			? await adminCall<{ id: string; name: string; phone: string }[]>('GET', `/users?q=${encodeURIComponent(personQuery)}`)
			: [];
	}

	async function run(event: SubmitEvent) {
		event.preventDefault();
		message = null;
		const params = new SvelteURLSearchParams();
		if (organizationId) params.set('organizationId', organizationId);
		if (userId) params.set('userId', userId);
		try {
			result = (await adminCall<{ features: NonNullable<typeof result> }>('GET', `/simulator?${params}`)).features;
		} catch (error) {
			message = messageOf(error);
		}
	}
	const select = 'min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 text-base';
</script>

<PageHeader title={t.title} subtitle={t.subtitle} back="admin/fonctionnalites" backLabel={fr.admin.features.title} />

<main class="page space-y-4 pt-3 pb-10" data-testid="simulateur">
	<form class="grid grid-cols-1 gap-4 rounded-xl border bg-card p-4 md:grid-cols-2 md:p-6" onsubmit={run}>
		<label class="block space-y-1"
			><span class="font-medium">{t.organization}</span>
			<select class={select} bind:value={organizationId} data-testid="simulateur-organisation">
				<option value="">{t.noOrganization}</option>
				{#each orgs as o (o.id)}<option value={o.id}>{o.name}</option>{/each}
			</select>
		</label>
		<div class="space-y-1">
			<label for="simulateur-recherche" class="block font-medium">{t.person}</label>
			<div class="flex gap-2">
				<Input id="simulateur-recherche" bind:value={personQuery} placeholder={fr.admin.people.searchPlaceholder} />
				<Button variant="outline" onclick={searchPeople}>{fr.admin.search}</Button>
			</div>
			<select class={select} bind:value={userId} aria-label={t.person} data-testid="simulateur-personne">
				<option value="">{t.noPerson}</option>
				{#each people as p (p.id)}<option value={p.id}>{p.name} ({p.phone})</option>{/each}
			</select>
		</div>
		<Button type="submit" class="md:col-span-2 md:w-fit">{t.run}</Button>
	</form>
	<FormAlert {message} />
	{#if result}
		{#if device.isPhone}
			<ul class="space-y-2" data-testid="resultat-simulateur">
				{#each Object.entries(result) as [key, r] (key)}
					<li class="space-y-1 rounded-xl border bg-card p-3" data-cle={key}>
						<code class="text-sm break-all">{key}</code>
						<p class="text-base">{r.reason}{r.stepNumber ? ` · ${t.step} ${r.stepNumber}` : ''}</p>
					</li>
				{/each}
			</ul>
		{:else}
			<div class="overflow-x-auto rounded-xl border bg-card">
				<table class="w-full text-left text-base" data-testid="resultat-simulateur">
					<thead class="border-b text-muted-foreground">
						<tr
							><th class="px-4 py-3 font-medium">{fr.fields.key}</th><th class="px-4 py-3 font-medium">{t.result}</th><th
								class="px-4 py-3 font-medium">{t.step}</th
							></tr
						>
					</thead>
					<tbody class="divide-y">
						{#each Object.entries(result) as [key, r] (key)}
							<tr data-cle={key}>
								<td class="px-4 py-2"
									><span class="block font-medium">{FEATURES_BY_KEY[key as keyof typeof FEATURES_BY_KEY]?.label ?? key}</span><code
										class="text-sm text-muted-foreground">{key}</code
									></td
								>
								<td class="px-4 py-2"
									><span class="rounded-full px-2.5 py-0.5 text-sm {r.enabled ? 'bg-success-soft' : 'border'}">{r.reason}</span></td
								>
								<td class="px-4 py-2 tabular-nums">{r.stepNumber ?? '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	{/if}
</main>
