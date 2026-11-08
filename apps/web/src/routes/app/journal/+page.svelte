<script lang="ts">
	/** Journal de l'organisation (lot 03, directeur) : en ajout seul, du plus récent au plus ancien. */
	import { onMount } from 'svelte';
	import type { AuditEntryView } from '@ziga/shared/organizations';
	import { can } from '@ziga/shared/permissions';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import AuditList from '#lib/components/org/AuditList.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';

	const t = fr.journal;
	const allowed = $derived(can(organizations.active?.role, 'audit.read'));
	let entries = $state<AuditEntryView[]>([]);
	let next = $state<string | null>(null);
	let message = $state<string | null>(null);

	async function load(cursor?: string) {
		try {
			const page = await organizations.call<{ entries: AuditEntryView[]; next: string | null }>(
				'GET',
				`/organization/audit${cursor ? `?avant=${cursor}` : ''}`
			);
			entries = cursor ? [...entries, ...page.entries] : page.entries;
			next = page.next;
		} catch (error) {
			message = messageOf(error);
		}
	}
	onMount(() => {
		if (allowed) void load();
	});
</script>

<PageHeader title={t.title} subtitle={t.subtitle} />
<main class="page space-y-4 pt-3 pb-10">
	{#if !allowed}
		<FormAlert message={fr.app.notFound} />
	{:else}
		<FormAlert {message} />
		<AuditList {entries} />
		{#if next}<Button variant="outline" onclick={() => load(next!)}>{t.more}</Button>{/if}
	{/if}
</main>
