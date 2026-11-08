/**
 * Règles vérifiées par la base (triggers, contraintes) traduites en erreurs métier : l'API les vérifie
 * d'abord elle-même, la base reste le dernier rempart (concurrence, oubli).
 */
import { AppError } from './app-error.js';

const RULES: Record<string, { status: number; message: string }> = {
	LANDLORD_SINGLE_MEMBER: { status: 409, message: 'Un bailleur particulier gère seul ses logements : pas de second membre.' },
	LAST_DIRECTOR: { status: 409, message: 'L’organisation doit garder au moins un directeur.' },
	MEMBER_IMMUTABLE: { status: 409, message: 'Un membre ne change ni d’organisation ni de personne.' },
	AUDIT_APPEND_ONLY: { status: 409, message: 'Le journal d’audit est en ajout seul.' }
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
		if (pg.code === '23505') return new AppError('CONFLICT', 'Cette valeur existe déjà.', 409);
		if (pg.code === '42501') return new AppError('FORBIDDEN', 'Accès refusé.', 403);
		current = (current as { cause?: unknown }).cause;
	}
	return null;
}
