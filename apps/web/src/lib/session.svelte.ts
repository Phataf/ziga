/**
 * Profil courant de la coque (lot 03) : dans l'espace de gestion, il vient du rôle de la personne dans
 * l'organisation active (jamais d'un choix à l'écran ni de l'URL) ; les autres espaces ont un profil fixe.
 * La coque reflète les permissions ; l'API les vérifie toujours elle-même.
 */
import { organizations } from './org/organizations.svelte';
import { profiles, type Profile, type Space } from './profiles';

class Session {
	agencyProfile = $derived<Profile>(profiles[organizations.profile ?? 'viewer']);

	profileFor(space: Space): Profile {
		switch (space) {
			case 'agency':
				return this.agencyProfile;
			case 'owner':
				return profiles.owner;
			case 'tenant':
				return profiles.tenant;
			case 'admin':
				return profiles.admin;
			default:
				return profiles.visitor;
		}
	}
}

export const session = new Session();
