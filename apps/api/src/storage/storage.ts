/**
 * Stockage de fichiers derrière une interface (CLAUDE.md §4) : S3 compatible (SeaweedFS en développement, D27)
 * ou dossier local pour le développement et les tests. Les documents privés ne sont jamais servis publiquement :
 * l'accès passe par des URL signées de courte durée (lot 07).
 *
 * Envoi direct par l'appareil (lot 07) : une URL d'écriture présignée (PUT) qui signe le type et la taille annoncés.
 * Le stockage refuse un corps d'une autre taille ou d'un autre type (vérifié contre SeaweedFS). La clé est décidée par
 * le serveur, jamais par l'appareil. Cloudflare R2 n'accepte pas le POST signé : le PUT signé vaut pour tous.
 */
export interface StorageAdapter {
	readonly driver: 's3' | 'local';
	/** Vérifie que le stockage est joignable et utilisable. */
	check(): Promise<void>;
	put(key: string, body: Buffer, contentType: string): Promise<void>;
	get(key: string): Promise<Buffer>;
	delete(key: string): Promise<void>;
	/** Taille et type de l'objet, ou null s'il n'existe pas. */
	stat(key: string): Promise<{ size: number; contentType: string | null } | null>;
	/** URL d'écriture signée : ce type et cette taille exactement, avant l'expiration. */
	presignPut(key: string, options: { contentType: string; contentLength: number; expiresInSeconds: number }): Promise<PresignedUpload>;
	/** URL de lecture signée, de courte durée ; le nom proposé au téléchargement est facultatif. */
	presignGet(key: string, options: { expiresInSeconds: number; fileName?: string; contentType?: string }): Promise<string>;
}

/** Envoi direct : l'appareil fait un PUT sur `url` avec exactement ces en-têtes et ce nombre d'octets. */
export interface PresignedUpload {
	url: string;
	method: 'PUT';
	headers: { 'content-type': string; 'content-length': string };
	expiresAt: string;
}

/** Nom de fichier proposé au téléchargement (Content-Disposition), sans caractère qui casserait l'en-tête. */
export function attachment(fileName: string): string {
	const ascii =
		fileName
			.normalize('NFD')
			.replace(/[^\x20-\x7e]/g, '')
			.replace(/["\\]/g, '') || 'document';
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export const STORAGE = Symbol('STORAGE');

/** Une clé de stockage n'a ni chemin absolu ni remontée de dossier. */
export function assertSafeKey(key: string): void {
	if (!key || key.startsWith('/') || key.split('/').some((part) => part === '..' || part === '.' || part === '')) {
		throw new Error(`Clé de stockage invalide : ${key}`);
	}
}
