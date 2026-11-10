/**
 * Règles vérifiées par la base (triggers, contraintes) traduites en erreurs métier : l'API les vérifie
 * d'abord elle-même, la base reste le dernier rempart (concurrence, oubli).
 */
import { AppError } from './app-error.js';

const RULES: Record<string, { status: number; message: string }> = {
	LANDLORD_SINGLE_MEMBER: { status: 409, message: 'Un bailleur particulier gère seul ses logements : pas de second membre.' },
	LAST_DIRECTOR: { status: 409, message: 'L’organisation doit garder au moins un directeur.' },
	MEMBER_IMMUTABLE: { status: 409, message: 'Un membre ne change ni d’organisation ni de personne.' },
	AUDIT_APPEND_ONLY: { status: 409, message: 'Le journal d’audit est en ajout seul.' },
	// Lot 07 : biens, unités, photos, règle 12.
	UNIT_PROPERTY_IMMUTABLE: { status: 409, message: 'Une unité ne change pas de bien.' },
	UNIT_AGENT_NOT_FIELD_AGENT: { status: 409, message: 'Seule une personne active au rôle agent de terrain peut être affectée.' },
	MANDATE_SCOPE_OWNER: { status: 409, message: 'Un mandat ne couvre que les biens de son propriétaire.' },
	PROPERTY_OWNER_LOCKED: { status: 409, message: 'Ce bien est sous mandat de gestion actif : son propriétaire ne change pas.' },
	MEDIA_QUOTA: { status: 409, message: '15 photos au plus par unité : retirez-en une avant d’en ajouter.' },
	MEDIA_OBJECT_IMMUTABLE: { status: 409, message: 'Une photo ne change pas d’objet.' },
	MEDIA_FINAL: { status: 409, message: 'Une photo refusée ou retirée le reste.' }
};

/** Contraintes nommées traduites en refus métier (le reste : CONFLICT). */
const CONSTRAINTS: Record<string, { code: string; status: number; message: string }> = {
	mandate_scopes_one_manager_per_unit: {
		code: 'UNIT_ALREADY_MANAGED',
		status: 409,
		message: 'Cette unité est déjà sous un mandat de gestion actif (règle 12) : passez par un transfert de gestion.'
	},
	mandate_scopes_one_manager_per_property: {
		code: 'UNIT_ALREADY_MANAGED',
		status: 409,
		message: 'Ce bien est déjà sous un mandat de gestion actif (règle 12) : passez par un transfert de gestion.'
	},
	units_label_per_property: { code: 'UNIT_LABEL_TAKEN', status: 409, message: 'Ce bien a déjà une unité avec ce libellé.' }
};

interface PgLike {
	code?: string;
	message?: string;
	constraint?: string;
}

/** Erreur PostgreSQL (directe ou enveloppée par Drizzle) → AppError, ou null si elle n'est pas connue. */
export function fromDatabaseError(error: unknown): AppError | null {
	let current: unknown = error;
	for (let depth = 0; depth < 4 && current; depth += 1) {
		const pg = current as PgLike;
		if (pg.code === 'P0001' && pg.message) {
			const key = Object.keys(RULES).find((k) => pg.message!.startsWith(k));
			if (key) return new AppError(key, RULES[key]!.message, RULES[key]!.status);
		}
		if (pg.code === '23505') {
			const known = pg.constraint ? CONSTRAINTS[pg.constraint] : undefined;
			if (known) return new AppError(known.code, known.message, known.status);
			return new AppError('CONFLICT', 'Cette valeur existe déjà.', 409);
		}
		if (pg.code === '42501') return new AppError('FORBIDDEN', 'Accès refusé.', 403);
		current = (current as { cause?: unknown }).cause;
	}
	return null;
}
