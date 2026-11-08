/**
 * Identifiants : UUIDv7 générés côté client (CLAUDE.md §6), nécessaires au hors ligne.
 * Ils sont triables par date de création, ce qui garde les index compacts.
 */
import { v7, validate, version } from 'uuid';
import { z } from 'zod';

export function newId(): string {
	return v7();
}

/** Vrai pour un UUID de version 7. */
export function isUuidV7(value: unknown): value is string {
	return typeof value === 'string' && validate(value) && version(value) === 7;
}

/** Vrai pour n'importe quel UUID valide (les identifiants reçus peuvent venir d'anciennes versions). */
export function isUuid(value: unknown): value is string {
	return typeof value === 'string' && validate(value);
}

export const idSchema = z.string().refine(isUuidV7, { message: 'Identifiant UUIDv7 attendu.' });
