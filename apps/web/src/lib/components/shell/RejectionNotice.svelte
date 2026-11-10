<script lang="ts">
	/**
	 * Modifications refusées par le serveur (lot 05, étape 4) :
	 * - après un envoi avec des refus, une notification avec le motif, jusqu'à ce que la personne la ferme (Échap) ;
	 * - tant que la liste de l'organisation active n'est pas vide, un lien vers « Modifications non acceptées ».
	 * La liste vient de la base de l'appareil, pour l'organisation active seulement.
	 */
	import { CircleAlert, X } from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';
	import { cn } from '#lib/utils.ts';

	let { class: className = '' }: { class?: string } = $props();
	const t = fr.rejections;
	let count = $state(0);

	$effect(() => {
		const id = organizations.activeId;
		if (!id) return;
		return sync.watch<{ n: number }>(LOCAL_QUERIES.rejectionCount, [id], (rows) => (count = Number(rows[0]?.n ?? 0)));
	});

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && sync.notice) sync.dismissNotice();
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if sync.notice}
	<div
		class={cn(
			// Visible où que l'on soit dans la page : au-dessus de la barre d'onglets sur téléphone, en bas à droite ailleurs.
			'fixed inset-x-4 bottom-24 z-40 flex items-start gap-3 rounded-xl border border-warning bg-warning-soft p-4 text-warning-foreground shadow-lg md:inset-x-auto md:right-6 md:bottom-6 md:w-[28rem]',
			className
		)}
		role="alert"
		data-testid="refus-notification"
	>
		<CircleAlert class="mt-0.5 size-5 shrink-0" aria-hidden="true" />
		<div class="min-w-0 flex-1 space-y-1">
			<p class="text-base font-semibold break-words">{t.notice(sync.notice.count, sync.notice.message)}</p>
			<p class="text-base">{t.noticeHint}</p>
			<a class="inline-flex min-h-11 items-center text-base font-medium underline" href={resolve('/app/modifications-non-acceptees')}
				>{t.open}</a
			>
		</div>
		<button
			type="button"
			class="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-md px-2 text-sm font-medium hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-2"
			onclick={() => sync.dismissNotice()}
		>
			<X class="size-4" aria-hidden="true" />{t.close}
		</button>
	</div>
{:else if count > 0}
	<a
		class={cn(
			'inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-warning-foreground underline',
			className
		)}
		href={resolve('/app/modifications-non-acceptees')}
		data-testid="refus-lien"
	>
		<CircleAlert class="size-4" aria-hidden="true" />{t.link(count)}
	</a>
{/if}
