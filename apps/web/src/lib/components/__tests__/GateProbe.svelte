<script lang="ts">
	/** Composant de test : une zone protégée par <FeatureGate>, avec ou sans texte de remplacement. */
	import FeatureGate from '../FeatureGate.svelte';

	let { key, withFallback = false }: { key: string; withFallback?: boolean } = $props();
</script>

{#if withFallback}
	<FeatureGate {key}>
		<button type="button" data-testid="contenu">Payer par Mobile Money</button>
		{#snippet fallback()}<p data-testid="remplacement">Bientôt disponible</p>{/snippet}
	</FeatureGate>
{:else}
	<FeatureGate {key}><button type="button" data-testid="contenu">Publier l’annonce</button></FeatureGate>
{/if}
