<script lang="ts">
	/**
	 * Réglages des reçus (lot 09), en ligne, directeur seulement (le gestionnaire les lit) : préfixe des numéros (2 à 6
	 * lettres, figé dès le premier reçu), premier numéro de l'année pour continuer un carnet papier (une seule fois, avant
	 * le premier reçu), largeur du ticket (58 ou 80 mm). Chaque réglage est journalisé par le serveur.
	 */
	import { onMount } from 'svelte';
	import { formatReceiptNumber, receiptSettingsSchema, type ReceiptSettingsView } from '@ziga/shared/receipts';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';

	let { editable }: { editable: boolean } = $props();
	const t = fr.payments;
	const year = new Date().getFullYear();

	let settings = $state<(ReceiptSettingsView & { firstNumberSet: boolean }) | null>(null);
	let prefix = $state('');
	let firstNumber = $state('');
	let ticketWidth = $state<58 | 80>(80);
	let message = $state<string | null>(null);
	let info = $state<string | null>(null);
	let busy = $state(false);

	function apply(s: ReceiptSettingsView & { firstNumberSet: boolean }) {
		settings = s;
		prefix = s.prefix ?? s.proposedPrefix;
		ticketWidth = s.ticketWidth;
		firstNumber = '';
	}

	onMount(async () => {
		if (!sync.online) return;
		try {
			apply(await organizations.call<ReceiptSettingsView & { firstNumberSet: boolean }>('GET', '/organization/receipt-settings'));
		} catch (error) {
			message = messageOf(error);
		}
	});

	const locked = $derived(!!settings?.numberingStartedAt);
	const example = $derived.by(() => {
		try {
			return formatReceiptNumber(prefix.trim().toUpperCase(), year, Number(firstNumber) || 1);
		} catch {
			return null;
		}
	});

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (!settings) return;
		message = null;
		info = null;
		const input: Record<string, unknown> = {};
		if (!locked && prefix.trim().toUpperCase() !== (settings.prefix ?? '')) input.prefix = prefix;
		if (!locked && !settings.firstNumberSet && firstNumber.trim()) input.firstNumber = Number(firstNumber);
		if (ticketWidth !== settings.ticketWidth) input.ticketWidth = ticketWidth;
		const parsed = receiptSettingsSchema.safeParse(input);
		if (!parsed.success) return void (message = parsed.error.issues[0]!.message);
		busy = true;
		try {
			apply(
				await organizations.call<ReceiptSettingsView & { firstNumberSet: boolean }>('PUT', '/organization/receipt-settings', parsed.data)
			);
			info = t.settingsSaved;
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}
</script>

<section class="space-y-3 rounded-2xl border bg-card p-4 md:p-6" aria-labelledby="titre-recus" data-testid="reglages-recus">
	<h2 id="titre-recus" class="text-lg font-semibold">{t.settingsTitle}</h2>
	<p class="text-base text-muted-foreground">{t.settingsSubtitle}</p>
	<FormAlert {message} />
	{#if !sync.online}
		<FormAlert message={t.offlineOnly} tone="info" />
	{:else if settings}
		<form class="space-y-4" onsubmit={save}>
			<div class="space-y-1">
				<label for="prefixe-recus" class="text-base font-medium">{t.prefix}</label>
				<Input
					id="prefixe-recus"
					bind:value={prefix}
					maxlength={6}
					autocapitalize="characters"
					disabled={!editable || locked}
					class="uppercase"
					data-testid="prefixe-recus"
				/>
				<p class="text-sm text-muted-foreground">{locked ? t.prefixLocked : t.prefixHint}</p>
				{#if !settings.prefix && !locked}<p class="text-sm text-muted-foreground">{t.prefixProposed(settings.proposedPrefix)}</p>{/if}
			</div>
			<div class="space-y-1">
				<label for="premier-numero" class="text-base font-medium">{t.firstNumber}</label>
				<Input
					id="premier-numero"
					inputmode="numeric"
					bind:value={firstNumber}
					disabled={!editable || locked || settings.firstNumberSet}
					data-testid="premier-numero"
				/>
				<p class="text-sm text-muted-foreground">{locked || settings.firstNumberSet ? t.firstNumberLocked : t.firstNumberHint}</p>
			</div>
			<fieldset class="space-y-2">
				<legend class="text-base font-medium">{t.ticketWidth}</legend>
				<div class="flex flex-wrap gap-2">
					{#each [58, 80] as const as w (w)}
						<label class="flex min-h-11 items-center gap-2 rounded-lg border-2 px-3 has-checked:border-primary">
							<input type="radio" name="largeur-ticket" value={w} bind:group={ticketWidth} disabled={!editable} />
							{t.ticketWidths[w]}
						</label>
					{/each}
				</div>
			</fieldset>
			{#if example && !locked}<p class="text-base tabular-nums" data-testid="exemple-numero">{t.example(example)}</p>{/if}
			{#if editable}<Button type="submit" disabled={busy}>{t.saveSettings}</Button>{/if}
		</form>
	{/if}
	<FormAlert message={info} tone="info" />
</section>
