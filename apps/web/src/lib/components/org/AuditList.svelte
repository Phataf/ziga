<script lang="ts">
	/**
	 * Liste d'événements du journal d'audit (lot 03) : action, auteur, date, et ce qui a changé (avant, après).
	 * Sert au journal de l'organisation (directeur) et à l'activité du compte (la personne elle-même).
	 */
	import { formatDate } from '@ziga/shared/dates';
	import { ROLE_LABELS, type AuditEntryView } from '@ziga/shared/organizations';
	import { auditChanges as changes } from '#lib/audit/format.ts';
	import { fr } from '#lib/i18n/fr.ts';

	let { entries, empty = fr.journal.empty }: { entries: AuditEntryView[]; empty?: string } = $props();

	const time = (iso: string) =>
		new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Ouagadougou' }).format(new Date(iso));
</script>

<ul class="divide-y rounded-xl border bg-card" data-testid="journal">
	{#each entries as e (e.id)}
		<li class="space-y-1 p-4" data-testid="evenement" data-action={e.action}>
			<div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
				<p class="font-semibold">{fr.actions[e.action] ?? e.action}</p>
				<p class="text-sm text-muted-foreground">{fr.journal.at(formatDate(e.occurredAt), time(e.occurredAt))}</p>
			</div>
			<p class="text-base text-muted-foreground">
				{e.actorName ?? fr.journal.system}{#if e.actorRole && e.actorRole in ROLE_LABELS}
					· {ROLE_LABELS[e.actorRole as keyof typeof ROLE_LABELS]}{/if}
			</p>
			{#each changes(e) as c (c.key)}
				<p class="text-base break-words">
					<span class="font-medium">{fr.fields[c.key]} :</span>
					{#if c.before}<span class="text-muted-foreground line-through decoration-1">{c.before}</span>{/if}
					{#if c.before && c.after}<span aria-hidden="true"> → </span><span class="sr-only">{fr.journal.after}</span>{/if}
					{#if c.after}<span>{c.after}</span>{/if}
				</p>
			{/each}
		</li>
	{:else}
		<li class="p-4 text-base text-muted-foreground">{empty}</li>
	{/each}
</ul>
