<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { fr } from '#lib/i18n/fr.ts';
</script>

<main class="page-narrow space-y-2 py-16">
	<h1 class="text-2xl font-bold">{page.status === 404 ? fr.app.notFound : page.error?.message}</h1>
	<a class="inline-flex min-h-11 items-center text-primary underline" href={resolve('')}>{fr.app.back}</a>
</main>
