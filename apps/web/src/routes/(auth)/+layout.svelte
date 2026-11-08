<script lang="ts">
	/** Écrans d'authentification : une colonne étroite, centrée, sur tous les appareils. */
	import { resolve } from '$app/paths';
	import { Building2 } from '@lucide/svelte';
	import { fr } from '#lib/i18n/fr.ts';

	let { children } = $props();
</script>

<div class="min-h-dvh bg-background px-4 py-6 md:py-12" data-testid="ecran-authentification">
	<div class="mx-auto w-full max-w-md space-y-6">
		<a href={resolve('')} class="inline-flex min-h-11 items-center gap-3 rounded-lg font-bold">
			<span class="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground" aria-hidden="true">
				<Building2 class="size-5" />
			</span>
			<span class="text-xl">{fr.app.name}</span>
		</a>
		<div class="rounded-2xl border bg-card p-5 md:p-8">
			{@render children()}
		</div>
	</div>
</div>
