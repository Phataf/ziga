/**
 * Profil courant de la coque. Jusqu'à l'authentification (lot 02) et aux rôles (lot 03), le profil de l'espace
 * de gestion se choisit par le paramètre `?profil=` (aperçu des navigations) ; les autres espaces ont un profil fixe.
 * Rien n'est gardé côté serveur : l'API reste sans état.
 */
import { agencyProfiles, profiles, type Profile, type ProfileId, type Space } from './profiles';

const KEY = 'apercu-profil';

function stored(): ProfileId | null {
	try {
		const v = sessionStorage.getItem(KEY);
		return v && (agencyProfiles as string[]).includes(v) ? (v as ProfileId) : null;
	} catch {
		return null;
	}
}

class Session {
	agencyProfile = $state<ProfileId>('manager');

	/** Lit `?profil=` (ou le dernier choisi dans l'onglet) pour l'espace de gestion. */
	syncFromUrl(url: { searchParams: { get(name: string): string | null } }): void {
		const asked = url.searchParams.get('profil');
		if (asked && (agencyProfiles as string[]).includes(asked)) {
			this.agencyProfile = asked as ProfileId;
			try {
				sessionStorage.setItem(KEY, asked);
			} catch {
				// navigation privée : le choix reste en mémoire
			}
		} else {
			this.agencyProfile = stored() ?? this.agencyProfile;
		}
	}

	profileFor(space: Space): Profile {
		switch (space) {
			case 'agency':
				return profiles[this.agencyProfile];
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
