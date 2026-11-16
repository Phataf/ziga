<script lang="ts">
	/**
	 * Légalisation et enregistrement d'un contrat signé (lot 08 bis, D20) : suivis pour mémoire, jamais bloquants. Date,
	 * commune, référence et preuve facultative (PDF ou photo, envoyée au stockage par URL signée) ; rappel mensuel de
	 * légalisation, que l'on peut couper. En ligne seulement.
	 */
	import { BellOff, BellRing, Landmark, Stamp } from '@lucide/svelte';
	import { formatDate, toIsoDate } from '@ziga/shared/dates';
	import { legalizationSchema, registrationSchema, type ContractDetailView, type ContractView } from '@ziga/shared/contracts';
	import type { DocumentView } from '@ziga/shared/documents';
	import { newId } from '@ziga/shared/ids';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';

	let { contract, canEdit }: { contract: ContractView; canEdit: boolean } = $props();

	const t = fr.contracts;
	const today = toIsoDate();
	let panel = $state<'legalization' | 'registration' | null>(null);
	let form = $state<Record<string, string>>({});
	let proof = $state<File | null>(null);
	let message = $state<string | null>(null);
	let saved = $state<string | null>(null);
	let busy = $state(false);

	function open(p: typeof panel) {
		panel = panel === p ? null : p;
		form = { date: today };
		proof = null;
		message = null;
		saved = null;
	}

	/** Preuve facultative : fiche du document, envoi direct au stockage ; le serveur la contrôle à l'enregistrement. */
	async function upload(kind: 'legalization' | 'registration'): Promise<string | null> {
		if (!proof) return null;
		const id = newId();
		const created = await organizations.call<{ document: DocumentView; upload: { url: string } }>(
			'POST',
			`/contracts/${contract.id}/uploads`,
			{
				id,
				kind,
				fileName: proof.name,
				mimeType: proof.type,
				byteSize: proof.size
			}
		);
		const put = await fetch(created.upload.url, { method: 'PUT', body: proof, headers: { 'content-type': proof.type } });
		if (!put.ok) throw new Error(fr.documents.badType);
		return id;
	}

	async function run(fn: () => Promise<void>) {
		message = null;
		saved = null;
		busy = true;
		try {
			await fn();
			panel = null;
			saved = t.saved;
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}

	async function legalize(event: SubmitEvent) {
		event.preventDefault();
		const parsed = legalizationSchema.safeParse({
			legalizedOn: form.date ?? '',
			commune: form.commune ?? '',
			reference: form.reference || null
		});
		if (!parsed.success) return void (message = parsed.error.issues[0]!.message);
		await run(async () => {
			const documentId = await upload('legalization');
			await organizations.call<ContractDetailView>('PUT', `/contracts/${contract.id}/legalization`, { ...parsed.data, documentId });
		});
	}

	async function register(event: SubmitEvent) {
		event.preventDefault();
		const parsed = registrationSchema.safeParse({ registeredOn: form.date ?? '', reference: form.reference || null });
		if (!parsed.success) return void (message = parsed.error.issues[0]!.message);
		await run(async () => {
			const documentId = await upload('registration');
			await organizations.call<ContractDetailView>('PUT', `/contracts/${contract.id}/registration`, { ...parsed.data, documentId });
		});
	}

	async function toggleReminder() {
		await run(async () => {
			await organizations.call<ContractDetailView>('PUT', `/contracts/${contract.id}/legalization-reminder`, {
				enabled: !contract.legalizationReminder
			});
		});
	}
</script>

{#snippet proofField(id: string)}
	<div class="space-y-1">
		<label for={id} class="block font-medium">{t.proof}</label>
		<input
			{id}
			type="file"
			accept="application/pdf,image/jpeg,image/png"
			class="block min-h-11 w-full text-base"
			onchange={(e) => (proof = (e.currentTarget as HTMLInputElement).files?.[0] ?? null)}
		/>
	</div>
{/snippet}

<section class="space-y-3 rounded-2xl border bg-card p-4 md:p-6" data-testid="suivi-legalisation">
	<div class="space-y-1">
		<h2 class="text-lg font-semibold">{t.tracking}</h2>
		<p class="text-sm text-muted-foreground">{t.trackingHint}</p>
	</div>
	<FormAlert {message} />
	{#if saved}<FormAlert message={saved} tone="info" />{/if}
	<ul class="space-y-2 text-base">
		<li data-testid="etat-legalisation">
			{contract.legalizedOn ? t.legalized(formatDate(contract.legalizedOn), contract.legalizationCommune ?? '') : t.notLegalized}
			{#if contract.legalizationReference}<span class="text-muted-foreground"> · {contract.legalizationReference}</span>{/if}
		</li>
		<li data-testid="etat-enregistrement">
			{contract.registeredOn ? t.registered(formatDate(contract.registeredOn)) : t.notRegistered}
			{#if contract.registrationReference}<span class="text-muted-foreground"> · {contract.registrationReference}</span>{/if}
		</li>
		{#if !contract.legalizedOn}
			<li class="text-sm text-muted-foreground">{t.reminder} : {contract.legalizationReminder ? t.reminderOn : t.reminderOff}</li>
		{/if}
	</ul>
	{#if canEdit}
		{#if !sync.online}
			<FormAlert message={t.online} tone="info" />
		{:else}
			<div class="flex flex-wrap gap-2">
				<Button variant="outline" onclick={() => open('legalization')} data-testid="indiquer-legalisation"
					><Stamp aria-hidden="true" />{t.legalize}</Button
				>
				<Button variant="outline" onclick={() => open('registration')} data-testid="indiquer-enregistrement"
					><Landmark aria-hidden="true" />{t.register}</Button
				>
				{#if !contract.legalizedOn}
					<Button variant="ghost" onclick={toggleReminder} disabled={busy}>
						{#if contract.legalizationReminder}<BellOff aria-hidden="true" />{:else}<BellRing aria-hidden="true" />{/if}
						{t.reminderToggle(contract.legalizationReminder)}
					</Button>
				{/if}
			</div>
			{#if panel === 'legalization'}
				<form class="space-y-3 rounded-xl border p-4" onsubmit={legalize} novalidate data-testid="formulaire-legalisation">
					<div class="grid gap-3 sm:grid-cols-3">
						<div class="space-y-1">
							<label for="date-legalisation" class="block font-medium">{t.legalizedOn}</label>
							<Input id="date-legalisation" type="date" max={today} bind:value={form.date} />
						</div>
						<div class="space-y-1">
							<label for="commune-legalisation" class="block font-medium">{t.commune}</label>
							<Input id="commune-legalisation" bind:value={form.commune} />
						</div>
						<div class="space-y-1">
							<label for="reference-legalisation" class="block font-medium">{t.reference}</label>
							<Input id="reference-legalisation" bind:value={form.reference} />
						</div>
					</div>
					{@render proofField('preuve-legalisation')}
					<Button type="submit" disabled={busy}>{t.save}</Button>
				</form>
			{:else if panel === 'registration'}
				<form class="space-y-3 rounded-xl border p-4" onsubmit={register} novalidate data-testid="formulaire-enregistrement">
					<div class="grid gap-3 sm:grid-cols-2">
						<div class="space-y-1">
							<label for="date-enregistrement" class="block font-medium">{t.registeredOn}</label>
							<Input id="date-enregistrement" type="date" max={today} bind:value={form.date} />
						</div>
						<div class="space-y-1">
							<label for="reference-enregistrement" class="block font-medium">{t.reference}</label>
							<Input id="reference-enregistrement" bind:value={form.reference} />
						</div>
					</div>
					{@render proofField('preuve-enregistrement')}
					<Button type="submit" disabled={busy}>{t.save}</Button>
				</form>
			{/if}
		{/if}
	{/if}
</section>
