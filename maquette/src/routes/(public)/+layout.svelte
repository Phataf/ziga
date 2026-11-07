<script lang="ts">
	import { ChevronLeft } from '@lucide/svelte';

	let { children } = $props();
</script>

<div class="min-h-dvh bg-white">
	<div class="border-b bg-muted">
		<a href="/" class="mx-auto flex min-h-11 max-w-lg items-center gap-1 px-3 text-base text-muted-foreground">
			<ChevronLeft class="size-5" aria-hidden="true" /> Revenir à l’application (démo)
		</a>
	</div>
	{@render children()}
</div>
