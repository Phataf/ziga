<script lang="ts">
	/**
	 * Modèles de relance (lot 10) : trois messages, du plus courtois au plus ferme, et les trois seuils (en jours de
	 * retard) qui font proposer chacun. Lus sur l'appareil (table synchronisée, ou modèles par défaut) ; enregistrés en
	 * ligne par la direction, journalisés par le serveur.
	 */
	import { onMount } from 'svelte';
	import { can } from '@ziga/shared/permissions';
	import { REMINDER_LEVELS, reminderSettingsSchema } from '@ziga/shared/reminders';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { reminderSettingsOf } from '#lib/collections/views.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';

	let { editable }: { editable: boolean } = $props();
	const t = fr.reminders;
	const canEdit = $derived(editable && can(organizations.active?.role, 'reminder.templates'));

	let templates = $state<[string, string, string]>(['', '', '']);
	let offsets = $state<[string, string, string]>(['', '', '']);
	let dirty = $state(false);
	let message = $state<string | null>(null);
	let info = $state<string | null>(null);
	let busy = $state(false);

	onMount(() =>
		sync.watch<Record<string, unknown>>(
			LOCAL_QUERIES.reminderSettings,
			[organizations.activeId],
			(rows) => {
				if (dirty) return;
				const s = reminderSettingsOf(rows[0]);
				templates = [...s.templates];
				offsets = [String(s.offsets[0]), String(s.offsets[1]), String(s.offsets[2])];
			},
			(error) => (message = messageOf(error))
		)
	);

	async function save(event: SubmitEvent) {
		event.preventDefault();
		message = null;
		info = null;
		const parsed = reminderSettingsSchema.safeParse({ templates, offsets: offsets.map((o) => Number(o)) });
		if (!parsed.success) return void (message = parsed.error.issues[0]!.message);
		busy = true;
		try {
			await organizations.call('PUT', '/organization/reminder-settings', parsed.data);
			dirty = false;
			info = t.settingsSaved;
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}
</script>

<section class="space-y-3 rounded-2xl border bg-card p-4 md:p-6" aria-labelledby="titre-relances" data-testid="modeles-relance">
	<h2 id="titre-relances" class="text-lg font-semibold">{t.settingsTitle}</h2>
	<p class="text-base text-muted-foreground">{t.settingsHint}</p>
	<FormAlert {message} />
	<FormAlert message={info} tone="info" />
	<form class="space-y-4" onsubmit={save} oninput={() => (dirty = true)}>
		{#each REMINDER_LEVELS as level, i (level)}
			<div class="space-y-2">
				<label for="modele-{level}" class="text-base font-medium">{t.levels[level]}</label>
				<textarea
					id="modele-{level}"
					bind:value={templates[i]}
					rows="5"
					maxlength="1000"
					disabled={!canEdit}
					class="w-full rounded-lg border bg-background p-3 text-base"
					data-testid="modele-relance"></textarea>
				<div class="flex flex-wrap items-center gap-2">
					<label for="seuil-{level}" class="text-sm text-muted-foreground">{t.offsets}</label>
					<Input id="seuil-{level}" inputmode="numeric" bind:value={offsets[i]} disabled={!canEdit} class="w-24 tabular-nums" />
					<span class="text-sm text-muted-foreground">{t.offsetUnit}</span>
				</div>
			</div>
		{/each}
		{#if canEdit}
			<Button type="submit" disabled={busy || !sync.online}>{t.saveSettings}</Button>
			{#if !sync.online}<p class="text-sm text-muted-foreground">{fr.statements.onlineOnly}</p>{/if}
		{:else}
			<p class="text-sm text-muted-foreground">{t.directorOnly}</p>
		{/if}
	</form>
</section>
