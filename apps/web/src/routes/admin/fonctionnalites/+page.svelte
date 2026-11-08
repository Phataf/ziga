<script lang="ts">
	/**
	 * Back-office : interrupteurs (lot 04, docs/FEATURE-FLAGS.md §7.1). Mode global à trois positions ; un changement
	 * demande un motif et une confirmation qui affiche le nombre d'organisations qui perdraient l'accès. Seul
	 * l'administrateur général modifie ; les autres rôles lisent.
	 */
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import { ChevronRight, FlaskConical, TriangleAlert } from '@lucide/svelte';
	import { formatDate } from '@ziga/shared/dates';
	import { GLOBAL_MODE_LABELS, GLOBAL_MODES, type GlobalMode } from '@ziga/shared/features';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import Sheet from '#lib/components/ui/sheet/Sheet.svelte';
	import { adminCall, allowed } from '#lib/admin/admin.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { cn } from '#lib/utils.ts';

	interface Row {
		key: string;
		label: string;
		globalMode: GlobalMode;
		planBound: boolean;
		requires: string[];
		plans: string[];
		activeOverrides: number;
		updatedAt: string;
	}

	const t = fr.admin.features;
	const canManage = $derived(allowed('feature.manage'));
	let rows = $state<Row[]>([]);
	let message = $state<string | null>(null);
	let pending = $state<{ row: Row; mode: GlobalMode } | null>(null);
	let impact = $state<{ losing: number; gaining: number } | null>(null);
	let confirmOpen = $state(false);
	let reason = $state('');
	let busy = $state(false);

	async function load() {
		try {
			rows = await adminCall<Row[]>('GET', '/features');
		} catch (error) {
			message = messageOf(error);
		}
	}
	onMount(load);

	async function ask(row: Row, mode: GlobalMode) {
		pending = { row, mode };
		reason = '';
		impact = null;
		confirmOpen = true;
		try {
			impact = await adminCall<{ losing: number; gaining: number }>('GET', `/features/${row.key}/impact?mode=${mode}`);
		} catch {
			impact = null;
		}
	}

	async function confirm(event: SubmitEvent) {
		event.preventDefault();
		if (!pending) return;
		busy = true;
		message = null;
		try {
			await adminCall('PUT', `/features/${pending.row.key}/mode`, { mode: pending.mode, reason });
			confirmOpen = false;
			await load();
		} catch (error) {
			message = messageOf(error);
			confirmOpen = false;
		} finally {
			busy = false;
		}
	}
</script>

<PageHeader title={t.title} subtitle={t.subtitle}>
	{#snippet actions()}
		<Button href={resolve('admin/fonctionnalites/simulateur')} variant="outline"><FlaskConical aria-hidden="true" />{t.simulator}</Button>
	{/snippet}
</PageHeader>

<main class="page space-y-4 pt-3 pb-10" data-testid="admin-fonctionnalites">
	<FormAlert {message} />
	{#if !canManage}<FormAlert message={t.readOnly} tone="info" />{/if}
	<ul class="space-y-2">
		{#each rows as f (f.key)}
			<li class="flex flex-col gap-3 rounded-xl border bg-card p-4 xl:flex-row xl:items-center" data-testid="interrupteur" data-cle={f.key}>
				<div class="min-w-0 flex-1">
					<p class="font-semibold">{f.label}</p>
					<p class="text-base break-words text-muted-foreground">
						<code class="text-sm">{f.key}</code> · {f.planBound ? t.planBound(f.plans.map((p) => fr.plans[p]).join(', ')) : t.notPlanBound}
						{#if f.requires.length}· {t.requires(f.requires.join(', '))}{/if} · {t.exceptions(f.activeOverrides)} · {t.updated(
							formatDate(f.updatedAt)
						)}
					</p>
				</div>
				<div class="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1" role="group" aria-label={t.modeGroup(f.key)}>
					{#each GLOBAL_MODES as m (m)}
						<button
							type="button"
							class={cn(
								'min-h-11 rounded-md px-2 text-base font-medium',
								f.globalMode === m
									? m === 'disabled'
										? 'bg-destructive text-destructive-foreground'
										: 'bg-card shadow-sm'
									: 'text-muted-foreground hover:bg-card/60'
							)}
							aria-pressed={f.globalMode === m}
							disabled={!canManage}
							onclick={() => f.globalMode !== m && ask(f, m)}
						>
							{GLOBAL_MODE_LABELS[m]}
						</button>
					{/each}
				</div>
				<Button href={resolve('/admin/fonctionnalites/[cle]', { cle: f.key })} variant="ghost" aria-label="{t.open} : {f.key}">
					{t.open}<ChevronRight aria-hidden="true" />
				</Button>
			</li>
		{/each}
	</ul>
</main>

{#if pending}
	<Sheet bind:open={confirmOpen} labelledby="titre-confirmer-interrupteur">
		<form class="space-y-4" onsubmit={confirm}>
			<div class="space-y-1 rounded-lg border-2 border-destructive bg-danger-soft p-3 text-destructive" role="alert" data-testid="impact">
				<p class="flex items-center gap-2 font-semibold"><TriangleAlert class="size-5" aria-hidden="true" />{t.allOrganizations}</p>
				<p class="text-base">
					<code class="text-sm">{pending.row.key}</code> :
					{impact
						? t.impact(
								GLOBAL_MODE_LABELS[pending.row.globalMode].toLowerCase(),
								GLOBAL_MODE_LABELS[pending.mode].toLowerCase(),
								impact.losing,
								impact.gaining
							)
						: '…'}
				</p>
			</div>
			<h2 id="titre-confirmer-interrupteur" class="pr-10 text-xl font-bold">{t.confirmTitle}</h2>
			<p class="text-base text-muted-foreground">{t.impactNote}</p>
			<label class="block space-y-1">
				<span class="font-medium">{fr.admin.reason}</span>
				<Input bind:value={reason} data-testid="motif-interrupteur" />
				<span class="block text-sm text-muted-foreground">{fr.admin.reasonHint}</span>
			</label>
			<div class="grid grid-cols-2 gap-2">
				<Button variant="outline" onclick={() => (confirmOpen = false)}>{fr.admin.cancel}</Button>
				<Button type="submit" variant="destructive" disabled={busy || reason.trim().length < 5}>{fr.admin.confirm}</Button>
			</div>
		</form>
	</Sheet>
{/if}
