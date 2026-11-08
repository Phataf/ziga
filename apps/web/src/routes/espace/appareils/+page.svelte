<script lang="ts">
	/** Mes appareils (lot 02) : appareils connectés au compte, déconnexion d'un appareil ou de celui-ci. */
	import { onMount } from 'svelte';
	import { formatDate } from '@ziga/shared/dates';
	import type { SessionView } from '@ziga/shared/auth';
	import type { AuditEntryView } from '@ziga/shared/organizations';
	import AuditList from '#lib/components/org/AuditList.svelte';
	import { Laptop, Smartphone, WifiOff } from '@lucide/svelte';
	import LogoutButton from '#lib/components/auth/LogoutButton.svelte';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { auth } from '#lib/auth/auth.svelte.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { NetworkError } from '#lib/auth/http.ts';
	import { fr } from '#lib/i18n/fr.ts';

	const t = fr.auth.devices;
	let sessions = $state<SessionView[] | null>(null);
	let offline = $state(false);
	let message = $state<string | null>(null);
	let info = $state<string | null>(null);

	const others = $derived(sessions?.filter((s) => !s.current) ?? []);
	const current = $derived(sessions?.find((s) => s.current));
	const isPhone = (label: string) => /Android|iPhone|iOS/i.test(label);

	let activity = $state<AuditEntryView[] | null>(null);

	async function load() {
		message = null;
		try {
			sessions = await auth.sessions();
			activity = (await auth.request<{ entries: AuditEntryView[] }>('GET', '/me/activity')).entries;
			offline = false;
		} catch (error) {
			if (error instanceof NetworkError) offline = true;
			else message = messageOf(error);
		}
	}

	async function revoke(id: string) {
		message = null;
		info = null;
		try {
			await auth.revokeSession(id);
			sessions = sessions?.filter((s) => s.id !== id) ?? null;
			info = t.revoked;
		} catch (error) {
			message = messageOf(error);
		}
	}

	onMount(load);
</script>

<!-- Retour du réseau : la liste se charge d'elle-même. -->
<svelte:window ononline={() => offline && load()} />

<PageHeader title={t.title} subtitle={t.subtitle} back="espace/compte" backLabel={fr.account.title} />

<main class="page-narrow space-y-4 pt-3 pb-10" data-testid="mes-appareils">
	{#if offline}
		<p class="flex items-start gap-2 rounded-lg bg-warning-soft p-3 text-base text-warning-foreground" role="status">
			<WifiOff class="mt-0.5 size-5 shrink-0" aria-hidden="true" />{t.offline}
		</p>
		<Button variant="outline" onclick={load}>{fr.auth.retry}</Button>
	{/if}
	<FormAlert {message} />
	<FormAlert message={info} tone="info" />

	{#if current}
		<section class="space-y-2" aria-labelledby="titre-cet-appareil">
			<h2 id="titre-cet-appareil" class="text-lg font-semibold">{t.current}</h2>
			<div class="space-y-2 rounded-xl border bg-card p-4" data-testid="appareil-courant">
				<p class="flex items-center gap-2 font-semibold">
					{#if isPhone(current.deviceLabel)}<Smartphone class="size-5" aria-hidden="true" />{:else}<Laptop
							class="size-5"
							aria-hidden="true"
						/>{/if}
					{current.deviceLabel}
				</p>
				<p class="text-base text-muted-foreground">{t.since(formatDate(current.createdAt))}</p>
				<LogoutButton class="border-2 border-input" />
			</div>
		</section>
	{/if}

	{#if sessions}
		<section class="space-y-2" aria-labelledby="titre-autres-appareils">
			<h2 id="titre-autres-appareils" class="text-lg font-semibold">{fr.auth.devices.short}</h2>
			<ul class="space-y-2">
				{#each others as s (s.id)}
					<li class="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4" data-testid="appareil">
						<div class="min-w-0">
							<p class="flex items-center gap-2 font-semibold">
								{#if isPhone(s.deviceLabel)}<Smartphone class="size-5 shrink-0" aria-hidden="true" />{:else}<Laptop
										class="size-5 shrink-0"
										aria-hidden="true"
									/>{/if}
								<span class="truncate">{s.deviceLabel}</span>
							</p>
							<p class="text-base text-muted-foreground">{t.lastUsed(formatDate(s.lastUsedAt))}</p>
						</div>
						<Button variant="outline" onclick={() => revoke(s.id)}>{t.revoke}</Button>
					</li>
				{:else}
					<li class="text-base text-muted-foreground">{t.none}</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if activity}
		<section class="space-y-2" aria-labelledby="titre-activite">
			<h2 id="titre-activite" class="text-lg font-semibold">{fr.account.activity}</h2>
			<AuditList entries={activity} empty={fr.account.activityEmpty} />
		</section>
	{/if}
</main>
