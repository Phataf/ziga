/** Noms des files BullMQ. Les tâches lourdes (PDF, images, relances, échéances en masse) passent par elles. */
export const EXAMPLE_QUEUE = 'example';

export interface ExampleJobData {
	/** Texte à traiter, pour vérifier le branchement de bout en bout. */
	message: string;
}

export interface ExampleJobResult {
	length: number;
	processedBy: number;
}

/** Logos des organisations (lot 03) : versions WebP (web) et PNG (PDF, pdf-lib) produites par sharp. */
export const LOGO_QUEUE = 'organization-logos';

export interface LogoJobData {
	organizationId: string;
	logoId: string;
}

/**
 * Mandats (lot 06) : expiration quotidienne. Un planificateur BullMQ ajoute la tâche chaque jour à 00:10 UTC (heure de
 * Ouagadougou) ; le worker expire les mandats actifs dont la date de fin est passée.
 */
export const MANDATES_QUEUE = 'mandates';
export const MANDATES_EXPIRY_SCHEDULER = 'mandates-daily-expiry';
export const MANDATES_EXPIRY_JOB = 'expire-due';
export const MANDATES_EXPIRY_PATTERN = '10 0 * * *';

export interface MandatesExpiryJobData {
	/** Date du jour imposée (tests) ; sinon la date du jour à Ouagadougou. */
	today?: string;
}

export interface MandatesExpiryJobResult {
	today: string;
	organizations: number;
	mandates: number;
}

/** Photos des biens et des unités (lot 07) : contrôle du fichier reçu, variantes WebP 320, 800 et 1600 sans EXIF. */
export const MEDIA_QUEUE = 'property-media';

export interface MediaJobData {
	organizationId: string;
	mediaId: string;
}
