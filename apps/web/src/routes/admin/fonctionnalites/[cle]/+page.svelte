<script lang="ts">
	/**
	 * Fiche d'une fonctionnalité (lot 04, §7.2) : formules qui l'incluent, exceptions (portée, cible, valeur, motif,
	 * échéance), ajout et révocation. Chaque changement est journalisé ; une exception pour une organisation apparaît
	 * aussi dans le journal de celle-ci.
	 */
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { Plus } from '@lucide/svelte';
	import { formatDate } from '@ziga/shared/dates';
	import { GLOBAL_MODE_LABELS, type GlobalMode } from '@ziga/shared/features';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import Sheet from '#lib/components/ui/sheet/Sheet.svelte';
	import { adminCall, allowed } from '#lib/admin/admin.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';

	interface Override {
		id: string;
		scope: 'organization' | 'user';
		targetId: string;
		targetName: string;
		value: boolean;
		reason: string;
		endsAt: string | null;
		createdBy: string | null;
	}
	interface Detail {
		key: string;
		label: string;
		description: string;
		globalMode: GlobalMode;
		planBound: boolean;
		requires: string[];
		overrides: Override[];
		plans: { id: string; label: string; included: boolean; quota: number | null }[];
	}

	const t = fr.admin.features;
	const key = $derived(page.params.cle ?? '');
	const canManage = $derived(allowed('feature.manage'));
	let detail = $state<Detail | null>(null);
	let message = $state<string | null>(null);
	let info = $state<string | null>(null);
	let orgs = $state<{ id: string; name: string }[]>([]);
	let people = $state<{ id: string; name: string; phone: string }[]>([]);

	let scope = $state<'organization' | 'user'>('organization');
	let targetId = $state('');
	let personQuery = $state('');
	let value = $state<'yes' | 'no'>('yes');
	let reason = $state('');
	let endsOn = $state('');

	let revokeTarget = $state<Override | null>(null);
	let revokeOpen = $state(false);
	let revokeReason = $state('');

	async function load() {
		try {
			detail = await adminCall<Detail>('GET', `/features/${key}`);
		} catch (error) {
			message = messageOf(error);
		}
	}
	onMount(async () => {
		await load();
		try {
			orgs = await adminCall<{ id: string; name: string }[]>('GET', '/organizations');
		} catch {
			orgs = [];
		}
	});

	async function searchPeople() {
		people = personQuery.trim()
			? await adminCall<{ id: string; name: string; phone: string }[]>('GET', `/users?q=${encodeURIComponent(personQuery)}`)
			: [];
	}

	async function add(event: SubmitEvent) {
		event.preventDefault();
		message = null;
		info = null;
		try {
			await adminCall('POST', '/overrides', { featureKey: key, scope, targetId, value: value === 'yes', reason, endsOn: endsOn || null });
			reason = '';
			endsOn = '';
			info = fr.adminActions['feature.override_set']!;
			await load();
		} catch (error) {
			message = messageOf(error);
		}
	}

	async function togglePlan(planId: string, included: boolean) {
		message = null;
		try {
			await adminCall('PUT', `/plans/${planId}/features/${key}`, { included });
			await load();
		} catch (error) {
			message = messageOf(error);
		}
	}

	async function revoke(event: SubmitEvent) {
		event.preventDefault();
		if (!revokeTarget) return;
		try {
			await adminCall('DELETE', `/overrides/${revokeTarget.id}`, { reason: revokeReason });
			revokeOpen = false;
			await load();
		} catch (error) {
			message = messageOf(error);
			revokeOpen = false;
		}
	}
	const select = 'min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 text-base';
</script>

<PageHeader title={detail?.label ?? key} subtitle={key} back="admin/fonctionnalites" backLabel={t.title} />

<main class="page space-y-4 pt-3 pb-10" data-testid="fiche-fonctionnalite">
	<FormAlert {message} />
	<FormAlert message={info} tone="info" />
	{#if detail}
		<p class="text-base">
			{GLOBAL_MODE_LABELS[detail.globalMode]}{#if detail.requires.length}
				· {t.requires(detail.requires.join(', '))}{/if}
		</p>
		<div class="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_24rem] xl:items-start">
			<section class="space-y-3" aria-labelledby="titre-exceptions">
				<h2 id="titre-exceptions" class="text-lg font-semibold">{t.overridesTitle}</h2>
				<ul class="divide-y rounded-xl border bg-card" data-testid="exceptions">
					{#each detail.overrides as o (o.id)}
						<li class="flex flex-wrap items-center gap-2 px-4 py-3" data-testid="exception">
							<span class="text-sm text-muted-foreground">{o.scope === 'organization' ? t.scopeOrganization : t.scopeUser}</span>
							<span class="font-medium">{o.targetName}</span>
							<span class="rounded-full px-2.5 py-0.5 text-sm {o.value ? 'bg-success-soft' : 'border'}"
								>{o.value ? t.forceYes : t.forceNo}</span
							>
							<span class="flex-1 text-base text-muted-foreground"
								>« {o.reason} »{o.endsAt ? ` · ${t.until(formatDate(o.endsAt))}` : ''}</span
							>
							{#if canManage}<Button variant="outline" onclick={() => ((revokeTarget = o), (revokeReason = ''), (revokeOpen = true))}
									>{t.revoke}</Button
								>{/if}
						</li>
					{:else}
						<li class="px-4 py-3 text-base text-muted-foreground">{t.noOverride}</li>
					{/each}
				</ul>
				{#if canManage}
					<form class="space-y-4 rounded-xl border bg-card p-4 md:p-6" onsubmit={add} aria-label={t.addOverride}>
						<h3 class="font-semibold">{t.addOverride}</h3>
						<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
							<label class="block space-y-1"
								><span class="font-medium">{t.scope}</span>
								<select class={select} bind:value={scope} onchange={() => (targetId = '')}>
									<option value="organization">{t.scopeOrganization}</option><option value="user">{t.scopeUser}</option>
								</select>
							</label>
							{#if scope === 'organization'}
								<label class="block space-y-1"
									><span class="font-medium">{t.target}</span>
									<select class={select} bind:value={targetId} data-testid="cible-organisation">
										<option value="">{t.chooseTarget}</option>
										{#each orgs as o (o.id)}<option value={o.id}>{o.name}</option>{/each}
									</select>
								</label>
							{:else}
								<div class="space-y-1">
									<label for="recherche-personne" class="block font-medium">{t.target}</label>
									<div class="flex gap-2">
										<Input id="recherche-personne" bind:value={personQuery} placeholder={fr.admin.people.searchPlaceholder} />
										<Button variant="outline" onclick={searchPeople}>{fr.admin.search}</Button>
									</div>
									<select class={select} bind:value={targetId} aria-label={t.target} data-testid="cible-personne">
										<option value="">{t.chooseTarget}</option>
										{#each people as p (p.id)}<option value={p.id}>{p.name} ({p.phone})</option>{/each}
									</select>
								</div>
							{/if}
						</div>
						<fieldset class="space-y-2">
							<legend class="font-medium">{t.value}</legend>
							<div class="flex flex-wrap gap-2">
								<label class="flex min-h-11 items-center gap-2 rounded-lg border-2 border-input px-3"
									><input type="radio" bind:group={value} value="yes" />{t.forceYes}</label
								>
								<label class="flex min-h-11 items-center gap-2 rounded-lg border-2 border-input px-3"
									><input type="radio" bind:group={value} value="no" />{t.forceNo}</label
								>
							</div>
						</fieldset>
						<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
							<label class="block space-y-1"
								><span class="font-medium">{fr.admin.reason}</span><Input bind:value={reason} data-testid="motif-exception" /></label
							>
							<label class="block space-y-1"
								><span class="font-medium">{fr.admin.organizations.endsOn}</span><Input type="date" bind:value={endsOn} /></label
							>
						</div>
						<Button type="submit" disabled={!targetId || reason.trim().length < 5}><Plus aria-hidden="true" />{t.addOverride}</Button>
					</form>
				{/if}
			</section>

			<section class="space-y-3 rounded-xl border bg-card p-4" aria-labelledby="titre-formules">
				<h2 id="titre-formules" class="text-lg font-semibold">{t.plansIncluding}</h2>
				{#if !detail.planBound}
					<p class="text-base text-muted-foreground">{t.notPlanBoundHint}</p>
				{:else}
					<ul class="space-y-2">
						{#each detail.plans as p (p.id)}
							<li class="flex flex-wrap items-center justify-between gap-2">
								<span
									>{p.label}{#if p.quota}
										· {t.quota} {p.quota}{/if}</span
								>
								{#if canManage}
									<Button variant="outline" aria-pressed={p.included} onclick={() => togglePlan(p.id, !p.included)}
										>{p.included ? t.included : t.excluded}</Button
									>
								{:else}
									<span class="text-muted-foreground">{p.included ? t.included : t.excluded}</span>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		</div>
	{/if}
</main>

<Sheet bind:open={revokeOpen} labelledby="titre-revoquer">
	<form class="space-y-4" onsubmit={revoke}>
		<h2 id="titre-revoquer" class="pr-10 text-xl font-bold">{t.revokeTitle}</h2>
		{#if revokeTarget}<p class="text-base">{revokeTarget.targetName} · « {revokeTarget.reason} »</p>{/if}
		<label class="block space-y-1"><span class="font-medium">{fr.admin.reason}</span><Input bind:value={revokeReason} /></label>
		<div class="grid grid-cols-2 gap-2">
			<Button variant="outline" onclick={() => (revokeOpen = false)}>{fr.admin.cancel}</Button>
			<Button type="submit" variant="destructive" disabled={revokeReason.trim().length < 5}>{t.revoke}</Button>
		</div>
	</form>
</Sheet>
