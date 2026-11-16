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

/**
 * Baux (lot 08) : tâche quotidienne à 00:20 UTC (heure de Ouagadougou), après l'expiration des mandats : baux signés
 * qui commencent, échéances des baux sans fin sur 12 mois glissants, échéances dues puis en retard le lendemain.
 */
export const LEASES_QUEUE = 'leases';
export const LEASES_DAILY_SCHEDULER = 'leases-daily';
export const LEASES_DAILY_JOB = 'leases-daily';
export const LEASES_DAILY_PATTERN = '20 0 * * *';

export interface LeasesDailyJobData {
	/** Date du jour imposée (tests) ; sinon la date du jour à Ouagadougou. */
	today?: string;
}

/**
 * Contrats (lot 08 bis, D23) : génération d'une version (modèle rempli par docxtemplater, PDF par Gotenberg) et aperçu
 * d'un modèle avec les données d'exemple. La tâche s'exécute dans le contexte de l'organisation et de la personne qui
 * l'a demandée (membre actif revérifié), avec les mêmes services que les routes ; origine d'audit `job`.
 */
export const CONTRACTS_QUEUE = 'contracts';
export const CONTRACT_GENERATE_JOB = 'generate';
export const TEMPLATE_PREVIEW_JOB = 'preview';

export interface ContractGenerateJobData {
	organizationId: string;
	userId: string;
	contractId: string;
	/** Numéro de la version attendue : un rejeu ne crée jamais une seconde version. */
	number: number;
}

export interface TemplatePreviewJobData {
	organizationId: string;
	userId: string;
	templateId: string;
}

/**
 * Reçus (lot 09) : PDF A6 et ticket d'un reçu émis (pdf-lib, QR code de vérification), régénérés avec « ANNULÉ » à
 * l'annulation. Chaque génération écrit de nouveaux fichiers : un PDF n'est jamais écrasé.
 */
export const RECEIPTS_QUEUE = 'receipts';
export const RECEIPT_PDF_JOB = 'pdf';

export interface ReceiptPdfJobData {
	organizationId: string;
	receiptId: string;
}
