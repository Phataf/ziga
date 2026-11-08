<script lang="ts">
	/** Déconnexion : elle exige le réseau (sinon la session resterait ouverte) ; l'échec est dit, pas masqué. */
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { LogOut } from '@lucide/svelte';
	import { auth } from '#lib/auth/auth.svelte.ts';
	import { NetworkError } from '#lib/auth/http.ts';
	import { messageOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { cn } from '#lib/utils.ts';

	let { class: className = '' }: { class?: string } = $props();
	let message = $state<string | null>(null);
	let busy = $state(false);

	async function logout() {
		message = null;
		busy = true;
		try {
			await auth.logout();
			await goto(resolve('connexion'), { replaceState: true });
		} catch (error) {
			message = error instanceof NetworkError ? fr.auth.logoutOffline : messageOf(error);
		} finally {
			busy = false;
		}
	}
</script>

<button
	type="button"
	class={cn('flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-foreground/80 hover:bg-accent hover:text-foreground', className)}
	onclick={logout}
	disabled={busy}
	data-testid="deconnexion"
>
	<LogOut class="size-5 shrink-0" aria-hidden="true" />{fr.auth.logout}
</button>
{#if message}<p role="alert" class="px-3 text-base text-destructive">{message}</p>{/if}
