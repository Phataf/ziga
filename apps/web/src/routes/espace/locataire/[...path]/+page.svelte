<script lang="ts">
	import ScreenRouter from '#lib/components/ScreenRouter.svelte';
	import { profiles } from '#lib/profiles.ts';
</script>

<ScreenRouter profile={profiles.tenant} />
