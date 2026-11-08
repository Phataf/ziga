<script lang="ts">
	/**
	 * Fonctionnalités de l'organisation (lot 04) : le directeur désactive ce qui lui est ouvert, jamais il n'active ce
	 * que la plateforme ferme ; chaque ligne dit pourquoi (« Non — formule Découverte »…).
	 */
	import { onMount } from 'svelte';
	import { CircleCheck, CircleMinus, Lock } from '@lucide/svelte';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { features as store } from '#lib/features/features.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';

	interface Row {
		key: string;
		label: string;
		enabled: boolean;
		reason: string;
		openByPlatform: boolean;
		disabledByOrganization: boolean;
	}

	let { editable }: { editable: boolean } = $props();
	const t = fr.orgSettings;
	let rows = $state<Row[]>([]);
	let message = $state<string | null>(null);

	onMount(async () => {
		try {
			rows = await organizations.call<Row[]>('GET', '/organization/features');
		} catch (error) {
			message = messageOf(error);
		}
	});

	async function set(key: string, disabled: boolean) {
		message = null;
		try {
			rows = await organizations.call<Row[]>('PUT', `/organization/features/${key}`, { disabled });
			await store.load(organizations.activeId);
		} catch (error) {
			message = messageOf(error);
		}
	}
</script>

<section
	class="space-y-3 rounded-2xl border bg-card p-4 md:p-6"
	aria-labelledby="titre-fonctions"
	data-testid="fonctionnalites-organisation"
>
	<h2 id="titre-fonctions" class="text-lg font-semibold">{t.features}</h2>
	<p class="text-base text-muted-foreground">{t.featuresHint}</p>
	<FormAlert {message} />
	<ul class="divide-y rounded-xl border">
		{#each rows as r (r.key)}
			<li class="flex flex-wrap items-center justify-between gap-3 p-3" data-testid="fonctionnalite" data-cle={r.key}>
				<div class="min-w-0 flex-1">
					<p class="font-medium break-words">{r.label}</p>
					<p class="flex items-center gap-1 text-sm text-muted-foreground">
						{#if r.enabled}<CircleCheck class="size-4 text-primary" aria-hidden="true" />{t.featureOn}
						{:else if r.disabledByOrganization}<CircleMinus class="size-4" aria-hidden="true" />{t.featureOff}
						{:else}<Lock class="size-4" aria-hidden="true" />{t.featureClosed} · {r.reason.replace(/^Non — /u, '')}{/if}
					</p>
				</div>
				{#if editable && r.openByPlatform}
					{#if r.disabledByOrganization}
						<Button variant="outline" onclick={() => set(r.key, false)}>{t.enable}</Button>
					{:else}
						<Button variant="outline" onclick={() => set(r.key, true)}>{t.disable}</Button>
					{/if}
				{/if}
			</li>
		{/each}
	</ul>
</section>
