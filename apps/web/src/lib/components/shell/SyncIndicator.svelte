<script lang="ts">
	/**
	 * État de la synchronisation (lot 05) : « À jour », « Hors ligne », « N modifications en attente », ou première
	 * synchronisation en cours. Pictogramme toujours accompagné du mot (CLAUDE.md §6) ; annoncé aux lecteurs d'écran (zone
	 * aria-live, sans le rôle « status », réservé aux messages des formulaires).
	 */
	import { Check, CloudOff, CloudUpload, RefreshCw } from '@lucide/svelte';
	import { fr } from '#lib/i18n/fr.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';
	import { cn } from '#lib/utils.ts';

	let { class: className = '' }: { class?: string } = $props();
	const t = fr.sync;
	const label = $derived(
		sync.state === 'offline'
			? t.offline
			: sync.state === 'pending'
				? t.pending(sync.pending)
				: sync.state === 'up_to_date'
					? t.upToDate
					: t.syncing
	);
	const Icon = $derived(
		sync.state === 'offline' ? CloudOff : sync.state === 'pending' ? CloudUpload : sync.state === 'up_to_date' ? Check : RefreshCw
	);
</script>

<p
	class={cn(
		'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium',
		sync.state === 'offline' || sync.state === 'pending'
			? 'bg-warning-soft text-warning-foreground'
			: 'bg-secondary text-secondary-foreground',
		className
	)}
	aria-live="polite"
	data-testid="etat-synchro"
	data-etat={sync.state}
>
	<Icon class="size-4" aria-hidden="true" />{label}
</p>
