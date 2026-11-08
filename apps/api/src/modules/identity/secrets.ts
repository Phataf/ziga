/**
 * Jetons et codes : rien n'est stocké en clair.
 * - Jeton de rafraîchissement : « <id de la personne>.<256 bits aléatoires> », stocké en SHA-256.
 *   L'identifiant de la personne fixe app.user_id : la règle d'accès en base ne laisse voir que ses jetons.
 * - Code SMS : 6 chiffres, stocké en HMAC-SHA256 avec un secret serveur (un SHA-256 seul se devinerait).
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { isUuid } from '@ziga/shared/ids';

export function newRefreshToken(userId: string): string {
	return `${userId}.${randomBytes(32).toString('base64url')}`;
}

export function refreshTokenUser(token: string): string | null {
	const [userId, secret, extra] = token.split('.');
	if (extra !== undefined || !secret || secret.length < 40 || !isUuid(userId)) return null;
	return userId!;
}

export function sha256(value: string): Buffer {
	return createHash('sha256').update(value).digest();
}

export function newOtpCode(): string {
	return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashOtp(secret: string, phone: string, code: string): Buffer {
	return createHmac('sha256', secret).update(`${phone}:${code}`).digest();
}

export function sameHash(a: Buffer, b: Buffer): boolean {
	return a.length === b.length && timingSafeEqual(a, b);
}

/** Clé de compteur sans le numéro en clair (les compteurs vivent dans Redis). */
export function counterKey(kind: string, value: string): string {
	return `ziga:auth:${kind}:${sha256(value).toString('base64url').slice(0, 32)}`;
}
