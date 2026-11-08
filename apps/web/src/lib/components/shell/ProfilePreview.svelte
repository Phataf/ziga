<script lang="ts">
	/**
	 * Aperçu des navigations de l'espace de gestion, en développement seulement, jusqu'à l'authentification
	 * (lot 02) et aux rôles (lot 03) : en production, le profil viendra du compte et jamais d'un choix à l'écran.
	 */
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { dev } from '$app/env';
	import { fr } from '#lib/i18n/fr.ts';
	import { agencyProfiles, profiles, type Profile } from '#lib/profiles.ts';

	let { profile }: { profile: Profile } = $props();
</script>

{#if dev && profile.space === 'agency'}
	<label class="block space-y-1 px-1">
		<span class="text-sm text-muted-foreground">{fr.app.profilePreview}</span>
		<select
			class="min-h-11 w-full rounded-lg border-2 border-input bg-card px-2"
			value={profile.id}
			onchange={(e) => goto(resolve(`app?profil=${e.currentTarget.value}`))}
		>
			{#each agencyProfiles as id (id)}<option value={id}>{profiles[id].label}</option>{/each}
		</select>
	</label>
{/if}
