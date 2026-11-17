<script lang="ts">
	/**
	 * Relance par WhatsApp (lot 10), d'un locataire ou en série : pour chaque locataire, le message pré-rempli (modèle de
	 * l'organisation, niveau proposé), « Ouvrir WhatsApp » ouvre wa.me dans un autre onglet, puis, au retour, « Oui,
	 * enregistrer » écrit la relance sur l'appareil (hors ligne compris) et passe au suivant. Aucun envoi automatique.
	 */
	import { MessageCircle } from '@lucide/svelte';
	import { newId } from '@ziga/shared/ids';
	import { formatFcfa } from '@ziga/shared/money';
	import { createReminderSchema, REMINDER_LEVELS, type ReminderLevel } from '@ziga/shared/reminders';
	import type { ArrearsGroup } from '@ziga/shared/collections';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import Sheet from '#lib/components/ui/sheet/Sheet.svelte';
	import { messageOf } from '#lib/auth/forms.ts';
	import { groupLink, groupMessage, levelFor, reminderFor, type ReminderSettings } from '#lib/collections/views.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';
	import { recordReminder } from '#lib/sync/writes.ts';

	let {
		open = $bindable(false),
		queue,
		settings,
		org,
		onDone
	}: {
		open?: boolean;
		queue: ArrearsGroup[];
		settings: ReminderSettings;
		org: { name: string; phone: string | null };
		onDone?: (recorded: number) => void;
	} = $props();

	const t = fr.reminders;
	let index = $state(0);
	let recorded = $state(0);
	let opened = $state(false);
	let level = $state<ReminderLevel>(1);
	let message = $state<string | null>(null);
	let busy = $state(false);

	const current = $derived(queue[index] ?? null);
	const text = $derived(current ? groupMessage(current, level, settings, org) : '');
	const link = $derived(current ? groupLink(current, text) : null);
	const series = $derived(queue.length > 1);

	$effect(() => {
		if (open) {
			index = 0;
			recorded = 0;
			opened = false;
			message = null;
		}
	});
	$effect(() => {
		if (current) level = levelFor(current);
	});

	function openWhatsApp() {
		if (!link) return;
		window.open(link, '_blank', 'noopener');
		opened = true;
	}

	function next() {
		opened = false;
		if (index + 1 < queue.length) index += 1;
		else finish();
	}

	function finish() {
		open = false;
		onDone?.(recorded);
	}

	async function confirm() {
		if (!current) return;
		busy = true;
		message = null;
		try {
			const parsed = createReminderSchema.parse(reminderFor(current, newId(), 'whatsapp_link', level));
			await recordReminder(sync.db ?? (await sync.start()), organizations.activeId!, parsed);
			recorded += 1;
			next();
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}
</script>

<Sheet bind:open labelledby="relance-titre" side="right">
	<div class="space-y-4" data-testid="relance">
		<h2 id="relance-titre" class="pr-10 text-xl font-semibold">
			{series ? t.series : fr.arrears.remind}
			{#if series}<span class="ml-2 text-base font-normal text-muted-foreground" data-testid="progression"
					>{t.progress(index + 1, queue.length)}</span
				>{/if}
		</h2>
		<FormAlert {message} />
		{#if current}
			<div class="rounded-xl border bg-background p-3">
				<p class="font-semibold break-words" data-testid="relance-locataire">{current.tenantName}</p>
				<p class="text-base tabular-nums">{formatFcfa(current.remindable)}</p>
			</div>
			{#if !opened}
				<fieldset class="space-y-2">
					<legend class="text-base font-medium">{t.template}</legend>
					<div class="grid gap-2">
						{#each REMINDER_LEVELS as l (l)}
							<label class="flex min-h-11 items-center gap-3 rounded-lg border-2 bg-card px-3 has-checked:border-primary">
								<input type="radio" name="niveau" value={l} bind:group={level} class="size-5" />{t.levels[l]}
							</label>
						{/each}
					</div>
				</fieldset>
				<div class="space-y-1">
					<p class="text-base font-medium">{t.preview}</p>
					<p class="rounded-lg border bg-background p-3 text-base whitespace-pre-line" data-testid="relance-message">{text}</p>
				</div>
				<div class="flex flex-wrap gap-2">
					<Button variant="whatsapp" onclick={openWhatsApp} disabled={!link} data-testid="ouvrir-whatsapp"
						><MessageCircle class="size-5" aria-hidden="true" />{t.open}</Button
					>
					{#if series}<Button variant="outline" onclick={next}>{t.skip}</Button>{/if}
				</div>
				{#if !link}<p class="text-sm text-muted-foreground">{fr.arrears.noPhone}</p>{/if}
			{:else}
				<div class="space-y-3" data-testid="relance-retour">
					<p class="text-lg font-semibold">{t.sentQuestion}</p>
					<p class="text-base text-muted-foreground">{t.sentHint}</p>
					<div class="flex flex-wrap gap-2">
						<Button onclick={confirm} disabled={busy} data-testid="confirmer-relance">{series ? t.confirmNext : t.confirm}</Button>
						<Button variant="outline" onclick={next}>{t.skip}</Button>
					</div>
				</div>
			{/if}
		{/if}
	</div>
</Sheet>
