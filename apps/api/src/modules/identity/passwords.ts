/**
 * Mots de passe hachés en argon2id (paramètres recommandés par l'OWASP : 19 Mio, 2 passes, 1 fil).
 * Jamais de mot de passe en clair, ni en base ni dans les journaux.
 */
import { hash, verify } from '@node-rs/argon2';

// `Algorithm` est une énumération « const » de @node-rs/argon2, inutilisable avec isolatedModules : 2 = Argon2id.
const ARGON2ID = 2;
const OPTIONS = { algorithm: ARGON2ID, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
	return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
	try {
		return await verify(passwordHash, password);
	} catch {
		return false;
	}
}

/**
 * Empreinte factice, vérifiée quand le numéro est inconnu : la réponse prend le même temps
 * que pour un mauvais mot de passe, et ne révèle pas si le numéro existe.
 */
let dummy: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
	dummy ??= hashPassword('mot-de-passe-factice-jamais-valide');
	return dummy;
}
