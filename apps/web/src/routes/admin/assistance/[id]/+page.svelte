<script lang="ts">
	/**
	 * Lecture d'assistance (lot 04) : le compte de l'organisation, ses membres et son journal, en lecture seule. Chaque
	 * page lue écrit une ligne « Lecture par l'assistance » dans le journal de l'organisation ; un accès clos ou expiré
	 * ne lit plus rien.
	 */
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { Eye } from '@lucide/svelte';
	import { ROLE_LABELS, type AuditEntryView, type OrganizationView } from '@ziga/shared/organizations';
	import { formatPhone } from '@ziga/shared/phone';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import AuditList from '#lib/components/org/AuditList.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { adminCall } from '#lib/admin/admin.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';

	const t = fr.admin.support;
	const id = $derived(page.params.id ?? '');
	let org = $state<OrganizationView | null>(null);
	let members = $state<{ userId: string; name: string; phone: string; role: string }[]>([]);
	let entries = $state<AuditEntryView[]>([]);
	let next = $state<string | null>(null);
	let tab = $state<'organization' | 'journal'>('organization');
	let message = $state<string | null>(null);

	async function readOrganization() {
		try {
			const res = await adminCall<{ organization: OrganizationView; members: typeof members }>(
				'GET',
				`/support-accesses/${id}/organization`
			);
			org = res.organization;
			members = res.members;
		} catch (error) {
			message = messageOf(error);
		}
	}
	async function readJournal(more = false) {
		tab = 'journal';
		try {
			const res = await adminCall<{ entries: AuditEntryView[]; next: string | null }>(
				'GET',
				`/support-accesses/${id}/journal${more && next ? `?avant=${next}` : ''}`
			);
			entries = more ? [...entries, ...res.entries] : res.entries;
			next = res.next;
		} catch (error) {
			message = messageOf(error);
		}
	}
	async function close() {
		try {
			await adminCall('POST', `/support-accesses/${id}/close`);
			await goto(resolve('admin/assistance'));
		} catch (error) {
			message = messageOf(error);
		}
	}
	onMount(readOrganization);
</script>

<PageHeader
	title={org ? t.readTitle(org.tradeName || org.legalName) : t.title}
	subtitle={t.readNote}
	back="admin/assistance"
	backLabel={t.title}
>
	{#snippet actions()}
		<Button variant="outline" onclick={close}>{t.closeAccess}</Button>
	{/snippet}
</PageHeader>

<main class="page space-y-4 pt-3 pb-10" data-testid="lecture-assistance">
	<FormAlert {message} />
	<p class="flex items-center gap-2 rounded-lg bg-muted p-3 text-base"><Eye class="size-5 shrink-0" aria-hidden="true" />{t.readNote}</p>
	<div class="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 sm:w-fit" role="tablist">
		<button
			type="button"
			role="tab"
			aria-selected={tab === 'organization'}
			class="min-h-11 rounded-md px-4 font-medium {tab === 'organization' ? 'bg-card shadow-sm' : 'text-muted-foreground'}"
			onclick={() => (tab = 'organization')}>{t.tabOrganization}</button
		>
		<button
			type="button"
			role="tab"
			aria-selected={tab === 'journal'}
			class="min-h-11 rounded-md px-4 font-medium {tab === 'journal' ? 'bg-card shadow-sm' : 'text-muted-foreground'}"
			onclick={() => readJournal()}>{t.tabJournal}</button
		>
	</div>
	{#if tab === 'organization' && org}
		<section class="space-y-3 rounded-xl border bg-card p-4" aria-label={t.tabOrganization}>
			<dl class="grid grid-cols-1 gap-x-4 gap-y-2 text-base sm:grid-cols-[auto_1fr]">
				<dt class="text-muted-foreground">{fr.fields.legalName}</dt>
				<dd>{org.legalName}</dd>
				<dt class="text-muted-foreground">{fr.fields.phone}</dt>
				<dd>{formatPhone(org.phone)}</dd>
				<dt class="text-muted-foreground">{fr.fields.commune}</dt>
				<dd>{org.commune || '—'}</dd>
				<dt class="text-muted-foreground">{fr.fields.planId}</dt>
				<dd>{fr.plans[org.planId]}</dd>
			</dl>
			<h2 class="font-semibold">{fr.admin.organizations.members}</h2>
			<ul class="divide-y rounded-xl border">
				{#each members as m (m.userId)}
					<li class="px-4 py-2">{m.name} · {formatPhone(m.phone)} · {ROLE_LABELS[m.role as keyof typeof ROLE_LABELS] ?? m.role}</li>
				{/each}
			</ul>
		</section>
	{:else if tab === 'journal'}
		<AuditList {entries} />
		{#if next}<Button variant="outline" onclick={() => readJournal(true)}>{fr.admin.journal.more}</Button>{/if}
	{/if}
</main>
