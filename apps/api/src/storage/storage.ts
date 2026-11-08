/**
 * Stockage de fichiers derrière une interface (CLAUDE.md §4) : S3 compatible (SeaweedFS en développement, D27)
 * ou dossier local pour le développement et les tests. Les documents privés ne sont jamais servis publiquement :
 * l'accès passera par des URL signées de courte durée (lot 07).
 */
export interface StorageAdapter {
	readonly driver: 's3' | 'local';
	/** Vérifie que le stockage est joignable et utilisable. */
	check(): Promise<void>;
	put(key: string, body: Buffer, contentType: string): Promise<void>;
	get(key: string): Promise<Buffer>;
	delete(key: string): Promise<void>;
}

export const STORAGE = Symbol('STORAGE');

/** Une clé de stockage n'a ni chemin absolu ni remontée de dossier. */
export function assertSafeKey(key: string): void {
	if (!key || key.startsWith('/') || key.split('/').some((part) => part === '..' || part === '.' || part === '')) {
		throw new Error(`Clé de stockage invalide : ${key}`);
	}
}
