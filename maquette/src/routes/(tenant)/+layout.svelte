<script lang="ts">
	import AppShell from '$lib/components/shell/AppShell.svelte';
	import { demo } from '$lib/demo.svelte';

	let { children } = $props();

	// Démo : ouvrir un lien de cet espace bascule sur le profil correspondant, avant le premier rendu
	// (le lien d'un reçu ouvre l'espace locataire).
	if (demo.profile.space !== 'tenant') demo.setProfile('tenant');
</script>

<AppShell>{@render children()}</AppShell>
