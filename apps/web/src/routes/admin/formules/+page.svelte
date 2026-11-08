<script lang="ts">
	/**
	 * Back-office : formules et abonnements (lot 04, §6). Prix et quotas sont des hypothèses du cadrage, modifiables
	 * par le commercial (journalisé, motif obligatoire). Abonnements saisis à la main ; le paiement reçu est enregistré
	 * par les finances. Les abonnements sont encaissés par la plateforme : ce ne sont jamais des loyers.
	 */
	import { onMount } from 'svelte';
	import { Plus } from '@lucide/svelte';
	import { formatDate, toIsoDate, addDays } from '@ziga/shared/dates';
	import { PLAN_IDS } from '@ziga/shared/features';
	import { formatFcfa } from '@ziga/shared/money';
	import { SUBSCRIPTION_PAYMENT_LABELS, type SubscriptionPaymentStatus } from '@ziga/shared/subscriptions';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import Sheet from '#lib/components/ui/sheet/Sheet.svelte';
	import { adminCall, allowed } from '#lib/admin/admin.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';

	interface Plan {
		id: string;
		label: string;
		monthlyPrice: number | null;
		yearlyPrice: number | null;
		maxUnits: number | null;
		maxUsers: number | null;
		features: { key: string; quota: number | null }[];
	}
	interface Subscription {
		id: string;
		organizationId: string;
		organizationName: string;
		planId: string;
		startsOn: string;
		endsOn: string;
		amount: number;
		paymentStatus: SubscriptionPaymentStatus;
		paymentReference: string | null;
		paidOn: string | null;
	}

	const t = fr.admin.plans;
	const canEditPlans = $derived(allowed('plan.manage'));
	const canCreate = $derived(allowed('subscription.manage'));
	const canRecord = $derived(allowed('subscription.record_payment'));

	let plans = $state<Plan[]>([]);
	let subs = $state<Subscription[]>([]);
	let orgs = $state<{ id: string; name: string }[]>([]);
	let message = $state<string | null>(null);
	let info = $state<string | null>(null);

	// Modification d'une formule
	let editing = $state<Plan | null>(null);
	let editOpen = $state(false);
	let monthly = $state('');
	let yearly = $state('');
	let maxUnits = $state('');
	let maxUsers = $state('');
	let reason = $state('');
	let editMessage = $state<string | null>(null);

	// Saisie d'un abonnement
	let newOpen = $state(false);
	let organizationId = $state('');
	let planId = $state('essential');
	let startsOn = $state(toIsoDate());
	let endsOn = $state(addDays(toIsoDate(), 30));
	let amount = $state('');
	let paymentStatus = $state<SubscriptionPaymentStatus>('pending');
	let reference = $state('');
	let paidOn = $state(toIsoDate());
	let newMessage = $state<string | null>(null);

	// Paiement reçu
	let paying = $state<Subscription | null>(null);
	let payOpen = $state(false);
	let payReference = $state('');
	let payDate = $state(toIsoDate());
	let payMessage = $state<string | null>(null);

	const price = (p: Plan) => (p.monthlyPrice === null ? t.onQuote : p.monthlyPrice === 0 ? t.free : t.perMonth(formatFcfa(p.monthlyPrice)));
	const limit = (n: number | null) => (n === null ? t.unlimited : String(n));
	const toInt = (s: string): number | null => (s.trim() === '' ? null : Number(s.replace(/\D/g, '')));

	async function load() {
		try {
			[plans, subs] = await Promise.all([adminCall<Plan[]>('GET', '/plans'), adminCall<Subscription[]>('GET', '/subscriptions')]);
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

	function edit(p: Plan) {
		editing = p;
		monthly = p.monthlyPrice === null ? '' : String(p.monthlyPrice);
		yearly = p.yearlyPrice === null ? '' : String(p.yearlyPrice);
		maxUnits = p.maxUnits === null ? '' : String(p.maxUnits);
		maxUsers = p.maxUsers === null ? '' : String(p.maxUsers);
		reason = '';
		editMessage = null;
		editOpen = true;
	}

	async function saveEdit(event: SubmitEvent) {
		event.preventDefault();
		if (!editing) return;
		editMessage = null;
		try {
			await adminCall('PATCH', `/plans/${editing.id}`, {
				monthlyPrice: toInt(monthly),
				yearlyPrice: toInt(yearly),
				maxUnits: toInt(maxUnits),
				maxUsers: toInt(maxUsers),
				reason
			});
			editOpen = false;
			info = fr.adminActions['plan.update']!;
			await load();
		} catch (error) {
			editMessage = messageOf(error);
		}
	}

	function openNew() {
		organizationId = '';
		amount = '';
		paymentStatus = 'pending';
		reference = '';
		newMessage = null;
		newOpen = true;
	}

	async function create(event: SubmitEvent) {
		event.preventDefault();
		newMessage = null;
		try {
			await adminCall('POST', '/subscriptions', {
				organizationId,
				planId,
				startsOn,
				endsOn,
				amount: toInt(amount) ?? 0,
				paymentStatus,
				paymentReference: paymentStatus === 'paid' ? reference : null,
				paidOn: paymentStatus === 'paid' ? paidOn : null
			});
			newOpen = false;
			info = fr.adminActions['subscription.create']!;
			await load();
		} catch (error) {
			newMessage = messageOf(error);
		}
	}

	function openPay(s: Subscription) {
		paying = s;
		payReference = '';
		payDate = toIsoDate();
		payMessage = null;
		payOpen = true;
	}

	async function record(event: SubmitEvent) {
		event.preventDefault();
		if (!paying) return;
		payMessage = null;
		try {
			await adminCall('POST', `/subscriptions/${paying.id}/payment`, { paymentReference: payReference, paidOn: payDate });
			payOpen = false;
			info = fr.adminActions['subscription.payment_record']!;
			await load();
		} catch (error) {
			payMessage = messageOf(error);
		}
	}
	const select = 'min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 text-base';
	const statuses = $derived(canRecord ? (['pending', 'paid', 'waived'] as const) : (['pending', 'waived'] as const));
</script>

<PageHeader title={t.title} subtitle={t.subtitle} />

<main class="page space-y-6 pt-3 pb-10" data-testid="admin-formules">
	<FormAlert {message} />
	<FormAlert message={info} tone="info" />

	<ul class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
		{#each plans as p (p.id)}
			<li class="flex flex-col gap-3 rounded-xl border bg-card p-4" data-testid="formule" data-formule={p.id}>
				<div>
					<p class="text-lg font-bold">{p.label}</p>
					<p class="text-base font-semibold text-primary">{price(p)}</p>
					{#if p.yearlyPrice}<p class="text-base text-muted-foreground">{t.perYear(formatFcfa(p.yearlyPrice))}</p>{/if}
				</div>
				<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-base">
					<dt class="text-muted-foreground">{t.maxUnits}</dt>
					<dd>{limit(p.maxUnits)}</dd>
					<dt class="text-muted-foreground">{t.maxUsers}</dt>
					<dd>{limit(p.maxUsers)}</dd>
					<dt class="text-muted-foreground">{t.featuresCount}</dt>
					<dd>{p.features.length}</dd>
				</dl>
				{#if canEditPlans}<Button variant="outline" class="mt-auto" onclick={() => edit(p)}>{t.edit}</Button>{/if}
			</li>
		{/each}
	</ul>

	<section class="space-y-3" aria-labelledby="titre-abonnements">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<h2 id="titre-abonnements" class="text-lg font-semibold">{t.subscriptions}</h2>
			{#if canCreate}<Button onclick={openNew}><Plus aria-hidden="true" />{t.newSubscription}</Button>{/if}
		</div>
		<p class="text-base text-muted-foreground">{t.notRent} {t.tiers}</p>
		{#if !device.isPhone}
			<div class="overflow-x-auto rounded-xl border bg-card">
				<table class="w-full text-left text-base">
					<thead class="border-b text-muted-foreground">
						<tr>
							<th class="px-4 py-3 font-medium">{t.organization}</th>
							<th class="px-4 py-3 font-medium">{fr.admin.organizations.plan}</th>
							<th class="px-4 py-3 font-medium">{t.period}</th>
							<th class="px-4 py-3 text-right font-medium">{fr.fields.amount}</th>
							<th class="px-4 py-3 font-medium">{t.paymentStatus}</th>
							<th class="px-4 py-3"><span class="sr-only">{t.recordPayment}</span></th>
						</tr>
					</thead>
					<tbody class="divide-y">
						{#each subs as s (s.id)}
							<tr data-testid="abonnement">
								<td class="px-4 py-2 font-medium">{s.organizationName}</td>
								<td class="px-4 py-2">{fr.plans[s.planId]}</td>
								<td class="px-4 py-2">{formatDate(s.startsOn)} – {formatDate(s.endsOn)}</td>
								<td class="px-4 py-2 text-right tabular-nums">{formatFcfa(s.amount)}</td>
								<td class="px-4 py-2"
									>{SUBSCRIPTION_PAYMENT_LABELS[s.paymentStatus]}{s.paymentReference ? ` · ${s.paymentReference}` : ''}</td
								>
								<td class="px-4 py-2 text-right">
									{#if canRecord && s.paymentStatus === 'pending'}<Button variant="outline" onclick={() => openPay(s)}
											>{t.recordPayment}</Button
										>{/if}
								</td>
							</tr>
						{:else}
							<tr><td colspan="6" class="px-4 py-3 text-muted-foreground">{fr.admin.none}</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<ul class="space-y-2">
				{#each subs as s (s.id)}
					<li class="space-y-2 rounded-xl border bg-card p-4" data-testid="abonnement">
						<p class="font-semibold">{s.organizationName} · {fr.plans[s.planId]}</p>
						<p class="text-base text-muted-foreground">{formatDate(s.startsOn)} – {formatDate(s.endsOn)} · {formatFcfa(s.amount)}</p>
						<p class="text-base">{SUBSCRIPTION_PAYMENT_LABELS[s.paymentStatus]}{s.paymentReference ? ` · ${s.paymentReference}` : ''}</p>
						{#if canRecord && s.paymentStatus === 'pending'}<Button variant="outline" class="w-full" onclick={() => openPay(s)}
								>{t.recordPayment}</Button
							>{/if}
					</li>
				{:else}
					<li class="text-base text-muted-foreground">{fr.admin.none}</li>
				{/each}
			</ul>
		{/if}
	</section>
</main>

<Sheet bind:open={editOpen} labelledby="titre-modifier-formule">
	<form class="space-y-4" onsubmit={saveEdit}>
		<h2 id="titre-modifier-formule" class="pr-10 text-xl font-bold">{editing ? t.editTitle(editing.label) : ''}</h2>
		<p class="text-base text-muted-foreground">{t.editHint}</p>
		<FormAlert message={editMessage} />
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
			<label class="block space-y-1"
				><span class="font-medium">{t.monthly}</span><Input inputmode="numeric" bind:value={monthly} data-testid="prix-mensuel" /></label
			>
			<label class="block space-y-1"><span class="font-medium">{t.yearly}</span><Input inputmode="numeric" bind:value={yearly} /></label>
			<label class="block space-y-1"
				><span class="font-medium">{t.maxUnits}</span><Input inputmode="numeric" bind:value={maxUnits} placeholder={t.unlimited} /></label
			>
			<label class="block space-y-1"
				><span class="font-medium">{t.maxUsers}</span><Input inputmode="numeric" bind:value={maxUsers} placeholder={t.unlimited} /></label
			>
		</div>
		<label class="block space-y-1">
			<span class="font-medium">{fr.admin.reason}</span>
			<Input bind:value={reason} data-testid="motif-formule" />
			<span class="block text-sm text-muted-foreground">{fr.admin.reasonHint}</span>
		</label>
		<div class="grid grid-cols-2 gap-2">
			<Button variant="outline" onclick={() => (editOpen = false)}>{fr.admin.cancel}</Button>
			<Button type="submit" disabled={reason.trim().length < 5}>{fr.admin.save}</Button>
		</div>
	</form>
</Sheet>

<Sheet bind:open={newOpen} labelledby="titre-nouvel-abonnement">
	<form class="space-y-4" onsubmit={create}>
		<h2 id="titre-nouvel-abonnement" class="pr-10 text-xl font-bold">{t.newSubscription}</h2>
		<FormAlert message={newMessage} />
		<label class="block space-y-1"
			><span class="font-medium">{t.organization}</span>
			<select class={select} bind:value={organizationId} data-testid="abonnement-organisation">
				<option value="">{fr.admin.features.chooseTarget}</option>
				{#each orgs as o (o.id)}<option value={o.id}>{o.name}</option>{/each}
			</select>
		</label>
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
			<label class="block space-y-1"
				><span class="font-medium">{fr.admin.organizations.plan}</span>
				<select class={select} bind:value={planId}>
					{#each PLAN_IDS.filter((p) => p !== 'discovery') as p (p)}<option value={p}>{fr.plans[p]}</option>{/each}
				</select>
			</label>
			<label class="block space-y-1"
				><span class="font-medium">{t.amount}</span><Input
					inputmode="numeric"
					bind:value={amount}
					data-testid="abonnement-montant"
				/></label
			>
			<label class="block space-y-1"><span class="font-medium">{t.startsOn}</span><Input type="date" bind:value={startsOn} /></label>
			<label class="block space-y-1"><span class="font-medium">{t.endsOn}</span><Input type="date" bind:value={endsOn} /></label>
		</div>
		<fieldset class="space-y-2">
			<legend class="font-medium">{t.paymentStatus}</legend>
			<div class="flex flex-wrap gap-2">
				{#each statuses as st (st)}
					<label class="flex min-h-11 items-center gap-2 rounded-lg border-2 border-input px-3"
						><input type="radio" bind:group={paymentStatus} value={st} />{SUBSCRIPTION_PAYMENT_LABELS[st]}</label
					>
				{/each}
			</div>
		</fieldset>
		{#if paymentStatus === 'paid'}
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<label class="block space-y-1"><span class="font-medium">{t.reference}</span><Input bind:value={reference} /></label>
				<label class="block space-y-1"><span class="font-medium">{t.paidOn}</span><Input type="date" bind:value={paidOn} /></label>
			</div>
		{/if}
		<div class="grid grid-cols-2 gap-2">
			<Button variant="outline" onclick={() => (newOpen = false)}>{fr.admin.cancel}</Button>
			<Button type="submit" disabled={!organizationId}>{fr.admin.save}</Button>
		</div>
	</form>
</Sheet>

<Sheet bind:open={payOpen} labelledby="titre-paiement-abonnement">
	<form class="space-y-4" onsubmit={record}>
		<h2 id="titre-paiement-abonnement" class="pr-10 text-xl font-bold">{t.recordPaymentTitle}</h2>
		{#if paying}<p class="text-base">{paying.organizationName} · {fr.plans[paying.planId]} · {formatFcfa(paying.amount)}</p>{/if}
		<p class="text-base text-muted-foreground">{t.notRent}</p>
		<FormAlert message={payMessage} />
		<label class="block space-y-1"
			><span class="font-medium">{t.reference}</span><Input bind:value={payReference} data-testid="reference-paiement" /></label
		>
		<label class="block space-y-1"><span class="font-medium">{t.paidOn}</span><Input type="date" bind:value={payDate} /></label>
		<div class="grid grid-cols-2 gap-2">
			<Button variant="outline" onclick={() => (payOpen = false)}>{fr.admin.cancel}</Button>
			<Button type="submit" disabled={payReference.trim().length < 3}>{t.recordPayment}</Button>
		</div>
	</form>
</Sheet>
