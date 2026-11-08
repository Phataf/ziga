/** Lecture et écriture du cookie de rafraîchissement (D28), sans dépendance. */
export function readCookie(header: string | undefined, name: string): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(';')) {
		const index = part.indexOf('=');
		if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
	}
	return undefined;
}

/** `__Host-…` : Secure, Path=/ et sans Domain, donc limité à l'hôte de l'API (api.ziga.com). */
export function refreshCookie(name: string, token: string, maxAgeSeconds: number): string {
	return `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearRefreshCookie(name: string): string {
	return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
