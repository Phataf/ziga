<script lang="ts">
	/**
	 * Back-office : organisations (lot 04, maquette lot 00 ter). Tableau filtrable sur ordinateur, cartes sur téléphone ;
	 * panneau latéral : compte, abonnement, fonctionnalités avec la raison ; validation, suspension (motif et
	 * confirmation renforcée), changement de formule, exception de quota, accès d'assistance.
	 */
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { BadgeCheck, Building2, House, LifeBuoy, TriangleAlert } from '@lucide/svelte';
	import { formatDate } from '@ziga/shared/dates';
	import { PLAN_IDS } from '@ziga/shared/features';
	import { formatPhone } from '@ziga/shared/phone';
	import { ROLE_LABELS } from '@ziga/shared/organizations';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import Sheet from '#lib/components/ui/sheet/Sheet.svelte';
	import { adminCall, allowed } from '#lib/admin/admin.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';

	interface Row {
		id: string;
		type: 'agency' | 'landlord';
		name: string;
		legalName: string;
		phone: string;
		commune: string;
		verificationStatus: string;
		suspendedReason: string | null;
		planId: string;
		members: number;
		createdAt: string;
		subscription: { stage: string; paidUntil: string | null; blockedFrom: string | null };
	}
	interface Detail extends Row {
		members: never;
		memberCount?: number;
		subscriptions: { id: string; planId: string; startsOn: string; endsOn: string; amount: number; paymentStatus: string }[];
		quotaOverrides: { id: string; quota: string; value: number; reason: string; endsAt: string | null }[];
		overrides: { id: string; featureKey: string; value: boolean; reason: string; endsAt: string | null }[];
		features: Record<string, { enabled: boolean; reason: string; stepNumber: number | null }>;
	}

	const t = fr.admin.organizations;
	const a = fr.admin;
	let rows = $state<Row[]>([]);
	let type = $state('');
	let status = $state('');
	let plan = $state('');
	let q = $state('');
	let message = $state<string | null>(null);

	let open = $state(false);
	let tab = $state<'account' | 'subscription' | 'features'>('account');
	let detail = $state<(Omit<Detail, 'members'> & { members: { userId: string; name: string; phone: string; role: string }[] }) | null>(
		null
	);
	let detailMessage = $state<string | null>(null);
	let info = $state<string | null>(null);

	// Confirmations (suspension, réintégration, formule, quota)
	let confirm = $state<null | 'suspend' | 'reinstate' | 'plan' | 'quota'>(null);
	let confirmOpen = $state(false);
	let reason = $state('');
	let newPlan = $state('essential');
	let quotaValue = $state(2);
	let quotaEnds = $state('');
	let busy = $state(false);

	async function load() {
		message = null;
		const params = new SvelteURLSearchParams();
		if (type) params.set('type', type);
		if (status) params.set('statut', status);
		if (plan) params.set('formule', plan);
		if (q.trim()) params.set('q', q.trim());
		try {
			rows = await adminCall<Row[]>('GET', `/organizations?${params}`);
		} catch (error) {
			message = messageOf(error);
		}
	}
	onMount(load);

	async function show(id: string) {
		detailMessage = null;
		info = null;
		tab = 'account';
		open = true;
		try {
			detail = await adminCall('GET', `/organizations/${id}`);
		} catch (error) {
			detailMessage = messageOf(error);
		}
	}

	async function act(fn: () => Promise<unknown>, done: string) {
		detailMessage = null;
		busy = true;
		try {
			await fn();
			info = done;
			confirmOpen = false;
			if (detail) await show(detail.id);
			await load();
		} catch (error) {
			detailMessage = messageOf(error);
			confirmOpen = false;
		} finally {
			busy = false;
		}
	}

	function ask(kind: NonNullable<typeof confirm>) {
		confirm = kind;
		reason = '';
		newPlan = detail?.planId === 'essential' ? 'pro' : 'essential';
		confirmOpen = true;
	}

	async function submitConfirm(event: SubmitEvent) {
		event.preventDefault();
		if (!detail) return;
		const id = detail.id;
		if (confirm === 'suspend')
			await act(() => adminCall('POST', `/organizations/${id}/suspend`, { reason }), fr.adminActions['organization.suspend']!);
		if (confirm === 'reinstate')
			await act(() => adminCall('POST', `/organizations/${id}/reinstate`, { reason }), fr.adminActions['organization.reinstate']!);
		if (confirm === 'plan')
			await act(
				() => adminCall('PUT', `/organizations/${id}/plan`, { planId: newPlan, reason }),
				fr.adminActions['organization.change_plan']!
			);
		if (confirm === 'quota')
			await act(
				() =>
					adminCall('POST', '/quota-overrides', {
						organizationId: id,
						quota: 'users',
						value: quotaValue,
						reason,
						endsOn: quotaEnds || null
					}),
				fr.adminActions['quota.override_set']!
			);
	}

	const stageTone = (stage: string) =>
		stage === 'blocked'
			? 'bg-danger-soft text-destructive'
			: stage === 'grace' || stage === 'reminder'
				? 'bg-warning-soft text-warning-foreground'
				: 'bg-secondary text-secondary-foreground';
	const select = 'min-h-12 rounded-lg border-2 border-input bg-card px-3 text-base';
</script>

<PageHeader title={t.title} subtitle={t.subtitle(rows.length)} />

<main class="page space-y-4 pt-3 pb-10" data-testid="admin-organisations">
	<form class="flex flex-wrap items-end gap-3" onsubmit={(e) => (e.preventDefault(), load())} role="search">
		<label class="space-y-1"
			><span class="block text-sm font-medium">{t.type}</span>
			<select class={select} bind:value={type} onchange={load}>
				<option value="">{a.all}</option><option value="agency">{t.agency}</option><option value="landlord">{t.landlord}</option>
			</select>
		</label>
		<label class="space-y-1"
			><span class="block text-sm font-medium">{t.status}</span>
			<select class={select} bind:value={status} onchange={load}>
				<option value="">{a.all}</option>
				{#each ['pending', 'verified', 'suspended'] as s (s)}<option value={s}>{a.verification[s]}</option>{/each}
				{#each ['reminder', 'grace', 'blocked'] as s (s)}<option value={s}>{fr.stages[s]}</option>{/each}
			</select>
		</label>
		<label class="space-y-1"
			><span class="block text-sm font-medium">{t.plan}</span>
			<select class={select} bind:value={plan} onchange={load}>
				<option value="">{a.all}</option>
				{#each PLAN_IDS as p (p)}<option value={p}>{fr.plans[p]}</option>{/each}
			</select>
		</label>
		<label class="min-w-48 flex-1 space-y-1"
			><span class="block text-sm font-medium">{a.search}</span>
			<Input bind:value={q} placeholder={t.searchPlaceholder} />
		</label>
		<Button type="submit" variant="outline">{a.search}</Button>
	</form>
	<FormAlert {message} />

	{#if !device.isDesktop}
		<ul class="space-y-2">
			{#each rows as o (o.id)}
				<li>
					<button
						type="button"
						class="w-full space-y-1 rounded-xl border bg-card p-4 text-left hover:bg-accent"
						onclick={() => show(o.id)}
						data-testid="organisation"
					>
						<p class="flex items-center gap-2 font-semibold">
							{o.name}{#if o.verificationStatus === 'verified'}<BadgeCheck
									class="size-4 text-primary"
									aria-label={a.verification.verified}
								/>{/if}
						</p>
						<p class="text-base text-muted-foreground">
							{o.type === 'agency' ? t.agency : t.landlord} · {fr.plans[o.planId]} · {o.members}
							{t.members.toLowerCase()}
						</p>
						<span class="inline-block rounded-full px-3 py-0.5 text-sm {stageTone(o.subscription.stage)}"
							>{fr.stages[o.subscription.stage]}</span
						>
					</button>
				</li>
			{:else}
				<li class="text-base text-muted-foreground">{a.none}</li>
			{/each}
		</ul>
	{:else}
		<div class="overflow-x-auto rounded-xl border bg-card">
			<table class="w-full text-left text-base">
				<thead class="border-b text-muted-foreground">
					<tr>
						<th class="px-4 py-3 font-medium">{fr.admin.organizations.title}</th>
						<th class="px-4 py-3 font-medium">{t.type}</th>
						<th class="px-4 py-3 font-medium">{t.status}</th>
						<th class="px-4 py-3 font-medium">{t.plan}</th>
						<th class="px-4 py-3 text-right font-medium">{t.members}</th>
						<th class="px-4 py-3 font-medium">{t.subscription}</th>
						<th class="px-4 py-3"><span class="sr-only">{fr.app.actions}</span></th>
					</tr>
				</thead>
				<tbody class="divide-y">
					{#each rows as o (o.id)}
						<tr data-testid="organisation">
							<td class="px-4 py-3">
								<span class="flex items-center gap-2 font-semibold"
									>{o.name}{#if o.verificationStatus === 'verified'}<BadgeCheck
											class="size-4 text-primary"
											aria-label={a.verification.verified}
										/>{/if}</span
								>
								<span class="text-sm text-muted-foreground">{t.since(formatDate(o.createdAt))}</span>
							</td>
							<td class="px-4 py-3"
								><span class="flex items-center gap-2"
									>{#if o.type === 'agency'}<Building2 class="size-4" aria-hidden="true" />{t.agency}{:else}<House
											class="size-4"
											aria-hidden="true"
										/>{t.landlord}{/if}</span
								></td
							>
							<td class="px-4 py-3">{a.verification[o.verificationStatus]}</td>
							<td class="px-4 py-3">{fr.plans[o.planId]}</td>
							<td class="px-4 py-3 text-right tabular-nums">{o.members}</td>
							<td class="px-4 py-3"
								><span class="rounded-full px-3 py-0.5 text-sm {stageTone(o.subscription.stage)}">{fr.stages[o.subscription.stage]}</span
								></td
							>
							<td class="px-4 py-2 text-right"><Button variant="outline" onclick={() => show(o.id)}>{a.open}</Button></td>
						</tr>
					{:else}
						<tr><td colspan="7" class="px-4 py-3 text-muted-foreground">{a.none}</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
	<p class="text-base text-muted-foreground">{t.privacy}</p>
</main>

<Sheet bind:open labelledby="titre-organisation" side="right">
	{#if detail}
		<div class="space-y-4" data-testid="fiche-organisation">
			<div class="pr-10">
				<h2 id="titre-organisation" class="text-xl font-bold">{detail.name}</h2>
				<p class="text-base text-muted-foreground">
					{detail.type === 'agency' ? t.agency : t.landlord} · {fr.plans[detail.planId]} · {a.verification[detail.verificationStatus]}
				</p>
			</div>
			<FormAlert message={detailMessage} />
			<FormAlert message={info} tone="info" />
			<div class="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1" role="tablist">
				{#each [['account', t.tabAccount], ['subscription', t.tabSubscription], ['features', t.tabFeatures]] as [id, label] (id)}
					<button
						type="button"
						role="tab"
						aria-selected={tab === id}
						class="min-h-11 rounded-md px-2 text-base font-medium {tab === id ? 'bg-card shadow-sm' : 'text-muted-foreground'}"
						onclick={() => (tab = id as typeof tab)}>{label}</button
					>
				{/each}
			</div>

			{#if tab === 'account'}
				<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
					<dt class="text-muted-foreground">{fr.settings.legalName}</dt>
					<dd class="break-words">{detail.legalName}</dd>
					<dt class="text-muted-foreground">{fr.settings.phone}</dt>
					<dd class="tabular-nums">{formatPhone(detail.phone)}</dd>
					<dt class="text-muted-foreground">{fr.settings.commune}</dt>
					<dd>{detail.commune}</dd>
					{#if detail.suspendedReason}<dt class="text-muted-foreground">{fr.admin.reason}</dt>
						<dd>{detail.suspendedReason}</dd>{/if}
				</dl>
				<h3 class="font-semibold">{t.members}</h3>
				<ul class="divide-y rounded-lg border">
					{#each detail.members as m (m.userId)}
						<li class="flex flex-wrap justify-between gap-2 px-3 py-2 text-base">
							<span>{m.name}</span><span class="text-muted-foreground">{ROLE_LABELS[m.role as keyof typeof ROLE_LABELS] ?? m.role}</span>
						</li>
					{/each}
				</ul>
				<div class="flex flex-wrap gap-2">
					{#if allowed('organization.verify') && detail.verificationStatus === 'pending'}
						<Button onclick={() => act(() => adminCall('POST', `/organizations/${detail!.id}/verify`, {}), t.verified)} disabled={busy}
							><BadgeCheck aria-hidden="true" />{t.verify}</Button
						>
					{/if}
					{#if allowed('organization.suspend')}
						{#if detail.verificationStatus === 'suspended'}
							<Button variant="outline" onclick={() => ask('reinstate')}>{t.reinstate}</Button>
						{:else}
							<Button variant="destructive" onclick={() => ask('suspend')}><TriangleAlert aria-hidden="true" />{t.suspend}</Button>
						{/if}
					{/if}
					{#if allowed('support.access')}
						<Button href={`${resolve('admin/assistance')}?organisation=${detail.id}`} variant="outline"
							><LifeBuoy aria-hidden="true" />{t.supportAccess}</Button
						>
					{/if}
				</div>
			{:else if tab === 'subscription'}
				<p class="text-base">
					<span class="rounded-full px-3 py-0.5 text-sm {stageTone(detail.subscription.stage)}">{fr.stages[detail.subscription.stage]}</span
					>
					{#if detail.subscription.paidUntil}
						· {fr.orgSettings.paidUntil(formatDate(detail.subscription.paidUntil))}{/if}
				</p>
				<ul class="divide-y rounded-lg border">
					{#each detail.subscriptions as s (s.id)}
						<li class="px-3 py-2 text-base">
							{formatDate(s.startsOn)} – {formatDate(s.endsOn)} · {fr.plans[s.planId]} · {s.paymentStatus === 'paid' ? fr.admin.yes : '—'}
						</li>
					{:else}
						<li class="px-3 py-2 text-base text-muted-foreground">{fr.orgSettings.noPeriod}</li>
					{/each}
				</ul>
				{#each detail.quotaOverrides as qo (qo.id)}
					<p class="text-base">{t.quotaOverride} : {qo.quota} → {qo.value} · « {qo.reason} »</p>
				{/each}
				<div class="flex flex-wrap gap-2">
					{#if allowed('organization.change_plan')}<Button variant="outline" onclick={() => ask('plan')}>{t.changePlan}</Button>{/if}
					{#if allowed('feature.manage')}<Button variant="outline" onclick={() => ask('quota')}>{t.quotaOverride}</Button>{/if}
				</div>
			{:else}
				<h3 class="font-semibold">{t.featuresTitle}</h3>
				<ul class="divide-y rounded-lg border" data-testid="etat-fonctionnalites">
					{#each Object.entries(detail.features) as [key, f] (key)}
						<li class="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
							<code class="text-sm break-all">{key}</code>
							<span class="rounded-full px-2.5 py-0.5 text-sm {f.enabled ? 'bg-success-soft' : 'border'}">{f.reason}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</Sheet>

<Sheet bind:open={confirmOpen} labelledby="titre-confirmation">
	<form class="space-y-4" onsubmit={submitConfirm}>
		{#if confirm === 'suspend'}
			<div class="space-y-1 rounded-lg border-2 border-destructive bg-danger-soft p-3 text-destructive" role="alert">
				<p class="flex items-center gap-2 font-semibold"><TriangleAlert class="size-5" aria-hidden="true" />{t.suspendTitle}</p>
				<p class="text-base">{t.suspendWarning}</p>
			</div>
		{/if}
		<h2 id="titre-confirmation" class="pr-10 text-xl font-bold">
			{confirm === 'suspend' ? t.suspendTitle : confirm === 'reinstate' ? t.reinstate : confirm === 'plan' ? t.changePlan : t.quotaOverride}
		</h2>
		{#if confirm === 'plan'}
			<p class="text-base text-muted-foreground">{t.changePlanHint}</p>
			<label class="block space-y-1"
				><span class="font-medium">{t.plan}</span>
				<select class="{select} w-full" bind:value={newPlan}
					>{#each PLAN_IDS as p (p)}<option value={p}>{fr.plans[p]}</option>{/each}</select
				>
			</label>
		{/if}
		{#if confirm === 'quota'}
			<label class="block space-y-1"
				><span class="font-medium">{t.quotaValue} ({fr.admin.people.title.toLowerCase()})</span><Input
					type="number"
					inputmode="numeric"
					min="1"
					bind:value={quotaValue}
				/></label
			>
			<label class="block space-y-1"><span class="font-medium">{t.endsOn}</span><Input type="date" bind:value={quotaEnds} /></label>
		{/if}
		<label class="block space-y-1">
			<span class="font-medium">{a.reason}</span>
			<Input bind:value={reason} data-testid="motif" />
			<span class="block text-sm text-muted-foreground">{a.reasonHint}</span>
		</label>
		<div class="grid grid-cols-2 gap-2">
			<Button variant="outline" onclick={() => (confirmOpen = false)}>{a.cancel}</Button>
			<Button type="submit" variant={confirm === 'suspend' ? 'destructive' : 'default'} disabled={busy || reason.trim().length < 5}
				>{a.confirm}</Button
			>
		</div>
	</form>
</Sheet>
