<script lang="ts">
	/**
	 * Back-office : accès d'assistance (lot 04). Motif obligatoire (15 caractères au moins), durée de 24 heures au plus,
	 * lecture seule avec les droits de l'agent ; l'organisation voit l'accès, son motif et chaque lecture dans son
	 * journal. Aucune connexion « en tant que » un utilisateur.
	 */
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { LifeBuoy, ShieldCheck } from '@lucide/svelte';
	import { SUPPORT_DURATIONS, SUPPORT_REASON_MIN } from '@ziga/shared/admin';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { adminCall, allowed, dateTime } from '#lib/admin/admin.ts';
	import { auth } from '#lib/auth/auth.svelte.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';

	interface Access {
		id: string;
		organizationId: string;
		organizationName: string;
		agentId: string;
		agentName: string;
		reason: string;
		startsAt: string;
		endsAt: string;
		closedAt: string | null;
		active: boolean;
	}

	const t = fr.admin.support;
	const canOpen = $derived(allowed('support.access'));
	let orgs = $state<{ id: string; name: string }[]>([]);
	let accesses = $state<Access[]>([]);
	let organizationId = $state(page.url.searchParams.get('organisation') ?? '');
	let reason = $state('');
	let duration = $state<number>(60);
	let message = $state<string | null>(null);
	let busy = $state(false);

	async function load() {
		try {
			accesses = await adminCall<Access[]>('GET', '/support-accesses');
		} catch (error) {
			message = messageOf(error);
		}
	}
	onMount(async () => {
		if (!canOpen) return;
		await load();
		try {
			orgs = await adminCall<{ id: string; name: string }[]>('GET', '/organizations');
		} catch {
			orgs = [];
		}
	});

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		message = null;
		try {
			const { id } = await adminCall<{ id: string }>('POST', '/support-accesses', { organizationId, reason, durationMinutes: duration });
			await goto(resolve('/admin/assistance/[id]', { id }));
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}

	async function close(a: Access) {
		message = null;
		try {
			await adminCall('POST', `/support-accesses/${a.id}/close`);
			await load();
		} catch (error) {
			message = messageOf(error);
		}
	}
	const select = 'min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 text-base';
</script>

<PageHeader title={t.title} subtitle={t.subtitle} />

<main class="page space-y-4 pt-3 pb-10" data-testid="admin-assistance">
	{#if !canOpen}
		<FormAlert message={fr.admin.noAccess} />
	{:else}
		<FormAlert {message} />
		<div class="grid grid-cols-1 gap-4 xl:grid-cols-[28rem_minmax(0,1fr)] xl:items-start">
			<form class="space-y-4 rounded-xl border bg-card p-4 md:p-6" onsubmit={submit} aria-labelledby="titre-ouvrir-acces">
				<h2 id="titre-ouvrir-acces" class="flex items-center gap-2 text-lg font-semibold">
					<LifeBuoy class="size-5" aria-hidden="true" />{t.open}
				</h2>
				<label class="block space-y-1"
					><span class="font-medium">{t.organization}</span>
					<select class={select} bind:value={organizationId} data-testid="acces-organisation">
						<option value="">{fr.admin.features.chooseTarget}</option>
						{#each orgs as o (o.id)}<option value={o.id}>{o.name}</option>{/each}
					</select>
				</label>
				<label class="block space-y-1"
					><span class="font-medium">{t.reason}</span>
					<textarea
						class="min-h-24 w-full rounded-lg border-2 border-input bg-card px-3 py-2 text-base"
						bind:value={reason}
						placeholder={t.reasonPlaceholder}
						data-testid="acces-motif"></textarea>
				</label>
				<label class="block space-y-1"
					><span class="font-medium">{t.duration}</span>
					<select class={select} bind:value={duration}>
						{#each SUPPORT_DURATIONS as d (d)}<option value={d}>{t.durations[d]}</option>{/each}
					</select>
				</label>
				<p class="flex gap-2 rounded-lg bg-muted p-3 text-base">
					<ShieldCheck class="mt-0.5 size-5 shrink-0" aria-hidden="true" />{t.rules}
				</p>
				<Button type="submit" class="w-full" disabled={busy || !organizationId || reason.trim().length < SUPPORT_REASON_MIN}
					>{t.submit}</Button
				>
			</form>

			<section class="space-y-2" aria-labelledby="titre-acces">
				<h2 id="titre-acces" class="text-lg font-semibold">{t.list}</h2>
				<ul class="divide-y rounded-xl border bg-card">
					{#each accesses as a (a.id)}
						<li class="space-y-2 p-4" data-testid="acces">
							<div class="flex flex-wrap items-baseline justify-between gap-2">
								<p class="font-semibold">{a.organizationName}</p>
								<p class="text-sm {a.active ? 'font-medium text-primary' : 'text-muted-foreground'}">
									{a.active ? t.active(dateTime(a.endsAt)) : t.ended}
								</p>
							</div>
							<p class="text-base text-muted-foreground">{a.agentName} · {dateTime(a.startsAt)} · « {a.reason} »</p>
							{#if a.active && a.agentId === auth.user?.id}
								<div class="flex flex-wrap gap-2">
									<Button href={resolve('/admin/assistance/[id]', { id: a.id })}>{t.read}</Button>
									<Button variant="outline" onclick={() => close(a)}>{t.closeAccess}</Button>
								</div>
							{/if}
						</li>
					{:else}
						<li class="p-4 text-base text-muted-foreground">{t.none}</li>
					{/each}
				</ul>
			</section>
		</div>
	{/if}
</main>
