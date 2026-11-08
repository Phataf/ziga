<script lang="ts">
	/**
	 * Affiche son contenu seulement si la fonctionnalité est ouverte à la personne dans l'organisation active (lot 04).
	 * `fallback` : ce qui s'affiche à la place quand l'utilisateur s'attend à la voir (« bientôt disponible »,
	 * docs/UX.md §2) ; sinon, rien. L'API refuse de toute façon (403 FEATURE_DISABLED).
	 */
	import type { Snippet } from 'svelte';
	import { features } from '#lib/features/features.svelte.ts';

	let { key, children, fallback }: { key: string; children: Snippet; fallback?: Snippet } = $props();
</script>

{#if features.isEnabled(key)}
	{@render children()}
{:else if fallback}
	{@render fallback()}
{/if}
