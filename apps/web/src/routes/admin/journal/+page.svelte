<script lang="ts">
	/**
	 * Back-office : journal (lot 04). Événements de plateforme (connexions, révocations, réutilisations de session) et
	 * actions du back-office, en ajout seul. Filtre par type d'action et par personne ; pagination par curseur.
	 */
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { formatDate } from '@ziga/shared/dates';
	import type { AuditEntryView } from '@ziga/shared/organizations';
	import { PLATFORM_ROLE_LABELS } from '@ziga/shared/permissions';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { adminCall } from '#lib/admin/admin.ts';
	import { auditChanges } from '#lib/audit/format.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';

	interface Entry extends AuditEntryView {
		organizationName: string | null;
		subjectName: string | null;
	}

	const t = fr.admin.journal;
	const FILTERS = ['', 'auth.', 'organization.', 'feature.', 'plan.', 'quota.', 'subscription.', 'support.'] as const;
	let action = $state<string>('');
	const userId = page.url.searchParams.get('personne') ?? '';
	let entries = $state<Entry[]>([]);
	let next = $state<string | null>(null);
	let message = $state<string | null>(null);

	const label = (a: string) => fr.adminActions[a] ?? fr.actions[a] ?? a;
	const actor = (e: Entry) =>
		`${e.actorName ?? fr.journal.system}${e.actorRole && e.actorRole in PLATFORM_ROLE_LABELS ? ` · ${PLATFORM_ROLE_LABELS[e.actorRole as keyof typeof PLATFORM_ROLE_LABELS]}` : ''}`;
	const time = (iso: string) =>
		new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Ouagadougou' }).format(new Date(iso));
	const details = (e: Entry) =>
		auditChanges(e)
			.map((c) => `${fr.fields[c.key]} : ${c.before && c.after ? `${c.before} → ${c.after}` : c.after || c.before}`)
			.join(' · ');

	async function load(more = false) {
		message = null;
		const params = new SvelteURLSearchParams();
		if (action) params.set('action', action);
		if (userId) params.set('userId', userId);
		if (more && next) params.set('avant', next);
		try {
			const res = await adminCall<{ entries: Entry[]; next: string | null }>('GET', `/audit?${params}`);
			entries = more ? [...entries, ...res.entries] : res.entries;
			next = res.next;
		} catch (error) {
			message = messageOf(error);
		}
	}
	onMount(() => load());
</script>

<PageHeader title={t.title} subtitle={t.subtitle} />

<main class="page space-y-4 pt-3 pb-10" data-testid="admin-journal">
	<label class="block max-w-sm space-y-1">
		<span class="font-medium">{t.filterAction}</span>
		<select
			class="min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 text-base"
			bind:value={action}
			onchange={() => load()}
			data-testid="filtre-action"
		>
			{#each FILTERS as f (f)}<option value={f}>{f ? t.families[f] : t.filterAll}</option>{/each}
		</select>
	</label>
	{#if userId}<FormAlert message={t.personFilter} tone="info" />{/if}
	<FormAlert {message} />

	{#if device.isPhone}
		<ul class="divide-y rounded-xl border bg-card" data-testid="journal-plateforme">
			{#each entries as e (e.id)}
				<li class="space-y-1 p-4" data-testid="evenement" data-action={e.action}>
					<p class="font-semibold">{label(e.action)}</p>
					<p class="text-sm text-muted-foreground">{fr.journal.at(formatDate(e.occurredAt), time(e.occurredAt))}</p>
					<p class="text-base text-muted-foreground">
						{actor(e)} · {e.organizationName ?? t.platform}{e.subjectName ? ` · ${e.subjectName}` : ''}
					</p>
					{#if details(e)}<p class="text-base break-words">{details(e)}</p>{/if}
				</li>
			{:else}
				<li class="p-4 text-base text-muted-foreground">{fr.admin.none}</li>
			{/each}
		</ul>
	{:else}
		<div class="overflow-x-auto rounded-xl border bg-card">
			<table class="w-full text-left text-base" data-testid="journal-plateforme">
				<thead class="border-b text-muted-foreground">
					<tr>
						<th class="px-4 py-3 font-medium">{t.date}</th>
						<th class="px-4 py-3 font-medium">{t.action}</th>
						<th class="px-4 py-3 font-medium">{t.actor}</th>
						<th class="px-4 py-3 font-medium">{t.organization}</th>
						<th class="px-4 py-3 font-medium">{t.details}</th>
					</tr>
				</thead>
				<tbody class="divide-y">
					{#each entries as e (e.id)}
						<tr data-testid="evenement" data-action={e.action} class="align-top">
							<td class="px-4 py-2 whitespace-nowrap tabular-nums">{formatDate(e.occurredAt)} {time(e.occurredAt)}</td>
							<td class="px-4 py-2 font-medium">{label(e.action)}</td>
							<td class="px-4 py-2"
								>{actor(e)}{#if e.subjectName}<span class="block text-sm text-muted-foreground">{t.subject} : {e.subjectName}</span
									>{/if}</td
							>
							<td class="px-4 py-2">{e.organizationName ?? t.platform}</td>
							<td class="px-4 py-2 break-words">{details(e) || '—'}</td>
						</tr>
					{:else}
						<tr><td colspan="5" class="px-4 py-3 text-muted-foreground">{fr.admin.none}</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
	{#if next}<Button variant="outline" onclick={() => load(true)}>{t.more}</Button>{/if}
</main>
