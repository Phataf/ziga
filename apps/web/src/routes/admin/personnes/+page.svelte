<script lang="ts">
	/**
	 * Back-office : personnes (lot 04, docs/FEATURE-FLAGS.md §7.3). Recherche par nom ou numéro ; fiche : rôle
	 * plateforme, appartenances, fonctionnalités hors organisation avec la raison, exceptions, événements de sécurité.
	 * Aucune connexion « en tant que » la personne.
	 */
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import { FlaskConical, Search } from '@lucide/svelte';
	import { formatDate } from '@ziga/shared/dates';
	import { FEATURES_BY_KEY } from '@ziga/shared/features';
	import { ROLE_LABELS, type AuditEntryView } from '@ziga/shared/organizations';
	import { PLATFORM_ROLE_LABELS } from '@ziga/shared/permissions';
	import { formatPhone } from '@ziga/shared/phone';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import AuditList from '#lib/components/org/AuditList.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import Sheet from '#lib/components/ui/sheet/Sheet.svelte';
	import { adminCall } from '#lib/admin/admin.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';

	interface Row {
		id: string;
		name: string;
		phone: string;
		status: string;
		platformRole: string | null;
		createdAt: string;
	}
	interface Person extends Row {
		memberships: { organizationId: string; name: string; type: string; role: string; planId: string }[];
		overrides: { id: string; featureKey: string; value: boolean; reason: string; endsAt: string | null }[];
		features: Record<string, { enabled: boolean; reason: string; stepNumber: number | null }>;
		events: AuditEntryView[];
	}

	const t = fr.admin.people;
	let q = $state('');
	let rows = $state<Row[]>([]);
	let message = $state<string | null>(null);
	let open = $state(false);
	let person = $state<Person | null>(null);

	const roleLabel = (r: string | null) => (r ? (PLATFORM_ROLE_LABELS[r as keyof typeof PLATFORM_ROLE_LABELS] ?? r) : t.noRole);
	const statusLabel = (s: string) => fr.admin.peopleStatus[s] ?? s;

	async function search(event?: SubmitEvent) {
		event?.preventDefault();
		message = null;
		try {
			rows = await adminCall<Row[]>('GET', `/users?q=${encodeURIComponent(q.trim())}`);
		} catch (error) {
			message = messageOf(error);
		}
	}
	onMount(() => search());

	async function show(id: string) {
		person = null;
		open = true;
		try {
			person = await adminCall<Person>('GET', `/users/${id}`);
		} catch (error) {
			message = messageOf(error);
			open = false;
		}
	}
</script>

<PageHeader title={t.title} subtitle={t.subtitle} />

<main class="page space-y-4 pt-3 pb-10" data-testid="admin-personnes">
	<form class="flex flex-col gap-2 sm:flex-row" onsubmit={search} role="search">
		<label for="recherche-personnes" class="sr-only">{t.searchPlaceholder}</label>
		<Input id="recherche-personnes" bind:value={q} placeholder={t.searchPlaceholder} class="sm:max-w-md" />
		<Button type="submit" variant="outline"><Search aria-hidden="true" />{fr.admin.search}</Button>
	</form>
	<FormAlert {message} />

	{#if !device.isPhone}
		<div class="overflow-x-auto rounded-xl border bg-card">
			<table class="w-full text-left text-base">
				<thead class="border-b text-muted-foreground">
					<tr>
						<th class="px-4 py-3 font-medium">{fr.fields.name}</th>
						<th class="px-4 py-3 font-medium">{fr.fields.phone}</th>
						<th class="px-4 py-3 font-medium">{t.role}</th>
						<th class="px-4 py-3 font-medium">{t.status}</th>
						<th class="px-4 py-3 font-medium">{t.createdAt}</th>
						<th class="px-4 py-3"><span class="sr-only">{fr.admin.open}</span></th>
					</tr>
				</thead>
				<tbody class="divide-y">
					{#each rows as p (p.id)}
						<tr data-testid="personne">
							<td class="px-4 py-2 font-medium">{p.name}</td>
							<td class="px-4 py-2 tabular-nums">{formatPhone(p.phone)}</td>
							<td class="px-4 py-2">{roleLabel(p.platformRole)}</td>
							<td class="px-4 py-2">{statusLabel(p.status)}</td>
							<td class="px-4 py-2">{formatDate(p.createdAt)}</td>
							<td class="px-4 py-2 text-right"><Button variant="outline" onclick={() => show(p.id)}>{fr.admin.open}</Button></td>
						</tr>
					{:else}
						<tr><td colspan="6" class="px-4 py-3 text-muted-foreground">{fr.admin.none}</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<ul class="space-y-2">
			{#each rows as p (p.id)}
				<li>
					<button
						type="button"
						class="w-full space-y-1 rounded-xl border bg-card p-4 text-left hover:bg-accent"
						onclick={() => show(p.id)}
						data-testid="personne"
					>
						<span class="block font-semibold">{p.name}</span>
						<span class="block text-base text-muted-foreground"
							>{formatPhone(p.phone)} · {roleLabel(p.platformRole)} · {statusLabel(p.status)}</span
						>
					</button>
				</li>
			{:else}
				<li class="text-base text-muted-foreground">{fr.admin.none}</li>
			{/each}
		</ul>
	{/if}
</main>

<Sheet bind:open side="right" labelledby="titre-fiche-personne">
	{#if person}
		<div class="space-y-5" data-testid="fiche-personne">
			<div class="space-y-1 pr-10">
				<h2 id="titre-fiche-personne" class="text-xl font-bold">{person.name}</h2>
				<p class="text-base text-muted-foreground">
					{formatPhone(person.phone)} · {roleLabel(person.platformRole)} · {statusLabel(person.status)}
				</p>
			</div>
			<div class="flex flex-wrap gap-2">
				<Button variant="outline" href={`${resolve('admin/fonctionnalites/simulateur')}?personne=${person.id}`}
					><FlaskConical aria-hidden="true" />{fr.admin.features.simulator}</Button
				>
				<Button variant="outline" href={`${resolve('admin/journal')}?personne=${person.id}`}>{fr.admin.journal.title}</Button>
			</div>

			<section class="space-y-2" aria-labelledby="titre-appartenances">
				<h3 id="titre-appartenances" class="font-semibold">{t.memberships}</h3>
				<ul class="divide-y rounded-xl border">
					{#each person.memberships as m (m.organizationId)}
						<li class="px-4 py-3">
							<span class="block font-medium">{m.name}</span>
							<span class="block text-base text-muted-foreground">
								{m.type === 'agency' ? fr.admin.organizations.agency : fr.admin.organizations.landlord} · {ROLE_LABELS[
									m.role as keyof typeof ROLE_LABELS
								] ?? m.role} · {fr.plans[m.planId]}
							</span>
						</li>
					{:else}
						<li class="px-4 py-3 text-base text-muted-foreground">{t.noMembership}</li>
					{/each}
				</ul>
			</section>

			<section class="space-y-2" aria-labelledby="titre-fonctionnalites-personne">
				<h3 id="titre-fonctionnalites-personne" class="font-semibold">{t.features}</h3>
				{#if person.overrides.length}
					<ul class="space-y-1">
						{#each person.overrides as o (o.id)}
							<li class="text-base">
								<code class="text-sm">{o.featureKey}</code> : {o.value ? fr.admin.features.forceYes : fr.admin.features.forceNo} · « {o.reason}
								»{o.endsAt ? ` · ${fr.admin.features.until(formatDate(o.endsAt))}` : ''}
							</li>
						{/each}
					</ul>
				{/if}
				<ul class="divide-y rounded-xl border">
					{#each Object.entries(person.features) as [key, r] (key)}
						<li class="flex flex-wrap items-baseline justify-between gap-x-3 px-4 py-2">
							<span class="font-medium">{FEATURES_BY_KEY[key as keyof typeof FEATURES_BY_KEY]?.label ?? key}</span>
							<span class="text-base {r.enabled ? '' : 'text-muted-foreground'}">{r.reason}</span>
						</li>
					{/each}
				</ul>
			</section>

			<section class="space-y-2" aria-labelledby="titre-evenements">
				<h3 id="titre-evenements" class="font-semibold">{t.events}</h3>
				<AuditList entries={person.events} empty={fr.admin.none} />
			</section>
		</div>
	{:else}
		<p id="titre-fiche-personne" class="text-base text-muted-foreground">…</p>
	{/if}
</Sheet>
