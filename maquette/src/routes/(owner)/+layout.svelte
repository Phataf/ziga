<script lang="ts">
	import AppShell from '$lib/components/shell/AppShell.svelte';
	import { demo } from '$lib/demo.svelte';

	let { children } = $props();

	// Démo : ouvrir un lien de cet espace bascule sur le profil correspondant, avant le premier rendu
	// (le lien d'un relevé ouvre l'espace propriétaire).
	if (demo.profile.space !== 'owner') demo.setProfile('owner');
</script>

<AppShell>{@render children()}</AppShell>
