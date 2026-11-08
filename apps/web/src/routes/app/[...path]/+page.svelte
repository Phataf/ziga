<script lang="ts">
	import ScreenRouter from '#lib/components/ScreenRouter.svelte';
	import { session } from '#lib/session.svelte.ts';
</script>

<ScreenRouter profile={session.profileFor('agency')} />
