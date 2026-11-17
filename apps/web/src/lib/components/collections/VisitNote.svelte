<script lang="ts">
	/**
	 * Visite ou appel noté sur l'appareil (lot 10), hors ligne compris : agent de terrain sur les locataires de ses
	 * unités, direction et gestion. Une relance en ajout seul, sans message envoyé.
	 */
	import { newId } from '@ziga/shared/ids';
	import { createReminderSchema } from '@ziga/shared/reminders';
	import type { ArrearsGroup } from '@ziga/shared/collections';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import Sheet from '#lib/components/ui/sheet/Sheet.svelte';
	import { messageOf } from '#lib/auth/forms.ts';
	import { reminderFor } from '#lib/collections/views.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';
	import { recordReminder } from '#lib/sync/writes.ts';

	let { open = $bindable(false), group, onDone }: { open?: boolean; group: ArrearsGroup | null; onDone?: () => void } = $props();
	const t = fr.reminders;
	let channel = $state<'visit' | 'call'>('visit');
	let note = $state('');
	let message = $state<string | null>(null);
	let busy = $state(false);

	$effect(() => {
		if (open) {
			channel = 'visit';
			note = '';
			message = null;
		}
	});

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (!group) return;
		busy = true;
		message = null;
		try {
			const parsed = createReminderSchema.parse(reminderFor(group, newId(), channel, null, note.trim() || null));
			await recordReminder(sync.db ?? (await sync.start()), organizations.activeId!, parsed);
			open = false;
			onDone?.();
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}
</script>

<Sheet bind:open labelledby="visite-titre">
	<form class="space-y-4" onsubmit={save} data-testid="note-visite">
		<h2 id="visite-titre" class="pr-10 text-xl font-semibold">{t.visitTitle}</h2>
		{#if group}<p class="font-semibold break-words">{group.tenantName}</p>{/if}
		<FormAlert {message} />
		<div class="grid gap-2 sm:grid-cols-2">
			{#each ['visit', 'call'] as const as c (c)}
				<label class="flex min-h-11 items-center gap-3 rounded-lg border-2 bg-card px-3 has-checked:border-primary">
					<input type="radio" name="canal" value={c} bind:group={channel} class="size-5" />{t.channels[c]}
				</label>
			{/each}
		</div>
		<div class="space-y-1">
			<label for="note-relance" class="text-base font-medium">{t.note}</label>
			<textarea
				id="note-relance"
				bind:value={note}
				maxlength="500"
				rows="3"
				placeholder={t.notePlaceholder}
				class="w-full rounded-lg border bg-background p-3 text-base"></textarea>
		</div>
		<Button type="submit" disabled={busy} class="w-full" data-testid="enregistrer-visite">{t.save}</Button>
	</form>
</Sheet>
