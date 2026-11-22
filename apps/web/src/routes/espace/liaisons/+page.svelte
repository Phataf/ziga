<script lang="ts">
	/**
	 * Mes fiches liées (lot 10 ter, étape 3d) : les liens en cours et actifs de la personne ; une demande de liaison à
	 * une agence vérifiée (réponse 1 : même réponse que la fiche existe ou non, débit limité par le serveur), le code reçu
	 * au numéro de la fiche, un nouveau code, le retrait motivé d'une liaison. En ligne seulement.
	 */
	import { onMount } from 'svelte';
	import { Link2, Unlink } from '@lucide/svelte';
	import { newId } from '@ziga/shared/ids';
	import {
		PERSON_LINK_RECORD_TYPES,
		personRevokeLinkSchema,
		requestPersonLinkSchema,
		verifyPersonLinkSchema,
		type LinkRequestOrganization,
		type MyPersonLinkView,
		type PersonLinkRecordType
	} from '@ziga/shared/person-links';
	import CodeField from '#lib/components/auth/CodeField.svelte';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import Sheet from '#lib/components/ui/sheet/Sheet.svelte';
	import { auth } from '#lib/auth/auth.svelte.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { myLinkStep } from '#lib/portals/links.ts';

	const t = fr.myLinks;
	let links = $state<MyPersonLinkView[]>([]);
	let agencies = $state<LinkRequestOrganization[]>([]);
	let loaded = $state(false);
	let message = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let busy = $state(false);
	let organizationId = $state('');
	let recordType = $state<PersonLinkRecordType>('tenant');
	/** Demande envoyée : son identifiant, pour saisir le code (même écran que la fiche existe ou non). */
	let pending = $state<{ id: string; organizationId: string } | null>(null);
	let codes = $state<Record<string, string>>({});
	let codeErrors = $state<Record<string, string | undefined>>({});
	let revokeTarget = $state<MyPersonLinkView | null>(null);
	let revokeOpen = $state(false);
	let reason = $state('');
	let reasonError = $state<string | null>(null);

	async function load() {
		try {
			[links, agencies] = await Promise.all([
				auth.request<MyPersonLinkView[]>('GET', '/me/person-links'),
				auth.request<LinkRequestOrganization[]>('GET', '/me/person-links/organizations')
			]);
			if (!organizationId && agencies[0]) organizationId = agencies[0].id;
			loaded = true;
		} catch (error) {
			message = messageOf(error);
		}
	}
	onMount(() => void load());

	async function request(event: SubmitEvent) {
		event.preventDefault();
		const parsed = requestPersonLinkSchema.safeParse({ id: newId(), organizationId, recordType });
		if (!parsed.success) return;
		busy = true;
		message = notice = null;
		try {
			notice = (await auth.request<{ message: string }>('POST', '/me/person-links/requests', parsed.data)).message;
			pending = { id: parsed.data.id, organizationId: parsed.data.organizationId };
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}

	async function verify(event: SubmitEvent, linkId: string, org: string) {
		event.preventDefault();
		const parsed = verifyPersonLinkSchema.safeParse({ organizationId: org, code: codes[linkId] ?? '' });
		codeErrors[linkId] = parsed.success ? undefined : parsed.error.issues[0]?.message;
		if (!parsed.success) return;
		busy = true;
		try {
			await auth.request('POST', `/me/person-links/${linkId}/verify`, parsed.data);
			notice = t.verified;
			if (pending?.id === linkId) pending = null;
			await load();
		} catch (error) {
			codeErrors[linkId] = messageOf(error);
		} finally {
			busy = false;
		}
	}

	async function resend(linkId: string, org: string) {
		message = null;
		try {
			notice = (await auth.request<{ message: string }>('POST', `/me/person-links/${linkId}/code`, { organizationId: org })).message;
		} catch (error) {
			message = messageOf(error);
		}
	}

	async function revoke(event: SubmitEvent) {
		event.preventDefault();
		if (!revokeTarget) return;
		const parsed = personRevokeLinkSchema.safeParse({ organizationId: revokeTarget.organizationId, reason });
		reasonError = parsed.success ? null : (parsed.error.issues[0]?.message ?? null);
		if (!parsed.success) return;
		busy = true;
		try {
			await auth.request('POST', `/me/person-links/${revokeTarget.id}/revoke`, parsed.data);
			revokeOpen = false;
			reason = '';
			notice = t.revoked;
			await load();
		} catch (error) {
			reasonError = messageOf(error);
		} finally {
			busy = false;
		}
	}
</script>

{#snippet codeForm(linkId: string, org: string)}
	<form class="space-y-3" onsubmit={(e) => verify(e, linkId, org)} novalidate data-testid="formulaire-code">
		<CodeField bind:value={() => codes[linkId] ?? '', (v) => (codes[linkId] = v)} error={codeErrors[linkId]} id="code-{linkId}" />
		<div class="flex flex-wrap gap-2">
			<Button type="submit" disabled={busy} data-testid="valider-code">{t.verify}</Button>
			<Button variant="outline" onclick={() => resend(linkId, org)} disabled={busy}>{t.resend}</Button>
		</div>
	</form>
{/snippet}

<PageHeader title={t.title} subtitle={t.subtitle} back="espace" />

<main class="page-narrow space-y-6 pt-3 pb-10" data-testid="mes-liaisons">
	<FormAlert {message} />
	{#if notice}<p role="status" class="text-base font-medium" data-testid="liaison-message">{notice}</p>{/if}

	<section class="space-y-3" aria-labelledby="titre-liens">
		<h2 id="titre-liens" class="text-lg font-semibold">{t.title}</h2>
		{#if loaded && !links.length}
			<p class="rounded-xl border bg-card p-4 text-base text-muted-foreground" data-testid="liaisons-vide">{t.none}</p>
		{/if}
		<ul class="space-y-3">
			{#each links as l (l.id)}
				{@const step = myLinkStep(l)}
				<li
					class="space-y-3 rounded-xl border bg-card p-4"
					data-testid="ma-liaison"
					data-etape={step}
					data-organisation={l.organizationName}
				>
					<div class="flex flex-wrap items-center justify-between gap-2">
						<span class="font-semibold break-words">{l.organizationName}</span>
						<Badge variant={step === 'active' ? 'success' : 'info'}>{t.steps[step]}</Badge>
					</div>
					<p class="text-base text-muted-foreground">{t.recordTypes[l.recordType]}</p>
					{#if step === 'enter_code'}{@render codeForm(l.id, l.organizationId)}{/if}
					<Button
						variant="outline"
						onclick={() => {
							revokeTarget = l;
							reason = '';
							reasonError = null;
							revokeOpen = true;
						}}
						data-testid="retirer-liaison"
					>
						<Unlink class="size-5" aria-hidden="true" />{t.revoke}
					</Button>
				</li>
			{/each}
		</ul>
	</section>

	<section class="space-y-3 rounded-xl border bg-card p-4" aria-labelledby="titre-demande">
		<h2 id="titre-demande" class="flex items-center gap-2 text-lg font-semibold">
			<Link2 class="size-5" aria-hidden="true" />{t.requestTitle}
		</h2>
		<p class="text-base text-muted-foreground">{t.requestHelp}</p>
		{#if loaded && !agencies.length}
			<p class="text-base">{t.noOrganization}</p>
		{:else if pending}
			{@render codeForm(pending.id, pending.organizationId)}
		{:else}
			<form class="space-y-4" onsubmit={request} novalidate data-testid="formulaire-demande">
				<label class="block space-y-1">
					<span class="text-base font-medium">{t.organization}</span>
					<select
						bind:value={organizationId}
						class="min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 text-base"
						data-testid="demande-agence"
					>
						{#each agencies as a (a.id)}<option value={a.id}>{a.name}</option>{/each}
					</select>
				</label>
				<label class="block space-y-1">
					<span class="text-base font-medium">{t.recordType}</span>
					<select
						bind:value={recordType}
						class="min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 text-base"
						data-testid="demande-type"
					>
						{#each PERSON_LINK_RECORD_TYPES as r (r)}<option value={r}>{t.recordTypes[r]}</option>{/each}
					</select>
				</label>
				<Button type="submit" disabled={busy || !organizationId} data-testid="envoyer-demande">{t.request}</Button>
			</form>
		{/if}
	</section>
</main>

<Sheet bind:open={revokeOpen} labelledby="retirer-titre" side="right">
	<form class="space-y-4" onsubmit={revoke} novalidate data-testid="formulaire-retrait">
		<h2 id="retirer-titre" class="pr-10 text-xl font-semibold">{t.revokeTitle}</h2>
		<p class="text-base text-muted-foreground">{t.revokeHelp}</p>
		<label class="block space-y-1">
			<span class="text-base font-medium">{t.reason}</span>
			<Input bind:value={reason} aria-invalid={!!reasonError} data-testid="motif-retrait" />
		</label>
		{#if reasonError}<p class="text-base text-destructive">{reasonError}</p>{/if}
		<Button type="submit" disabled={busy} class="w-full" data-testid="confirmer-retrait">{t.revokeConfirm}</Button>
	</form>
</Sheet>
