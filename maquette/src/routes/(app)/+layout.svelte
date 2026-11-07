<script lang="ts">
	import AppShell from '$lib/components/shell/AppShell.svelte';
	import { demo } from '$lib/demo.svelte';

	let { children } = $props();

	// Démo : ouvrir un lien de cet espace bascule sur le profil correspondant, avant le premier rendu
	// (un propriétaire ou un locataire qui ouvre l'espace agence redevient gestionnaire).
	if (demo.profile.space !== 'agency') demo.setProfile('manager');
</script>

<AppShell>{@render children()}</AppShell>
