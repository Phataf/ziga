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

/**
 * Relevés propriétaires (lot 10) : PDF d'un relevé émis, et brouillons du mois écoulé, le 1er de chaque mois à 01:00 UTC
 * (heure de Ouagadougou). Un brouillon n'est qu'un calcul : rejouée, la tâche le recalcule sans rien émettre.
 */
export const STATEMENTS_QUEUE = 'owner-statements';
export const STATEMENT_PDF_JOB = 'statement-pdf';
export const STATEMENTS_MONTHLY_SCHEDULER = 'owner-statements-monthly';
export const STATEMENTS_MONTHLY_JOB = 'monthly-drafts';
export const STATEMENTS_MONTHLY_PATTERN = '0 1 1 * *';

export interface StatementPdfJobData {
	organizationId: string;
	statementId: string;
}

export interface StatementsMonthlyJobData {
	/** Mois des brouillons imposé (tests) ; sinon le mois écoulé. */
	month?: string;
}

export interface StatementsMonthlyJobResult {
	month: string;
	organizations: number;
	drafts: number;
}

/**
 * États des lieux (lot 10 bis, étape 4) : PDF de l'état des lieux, produit à la signature (cases cochées ou scan) et à
 * chaque photo reçue après elle. Chaque génération écrit une nouvelle version : un PDF n'est jamais écrasé. La tâche
 * s'exécute dans le contexte de la personne qui l'a déclenchée (membre actif revérifié) ; origine d'audit `job`.
 */
export const INSPECTIONS_QUEUE = 'inspections';
export const INSPECTION_REPORT_JOB = 'report';

export interface InspectionReportJobData {
	organizationId: string;
	userId: string;
	inspectionId: string;
}

/**
 * Import Excel (lot 11) : lecture et analyse du fichier (prévisualisation), exécution onglet par onglet par les services
 * des modules, annulation sous 24 heures ; et, chaque jour à 00:40 UTC, effacement des fichiers d'origine conservés 90
 * jours. Le fichier n'est jamais lu dans la requête HTTP.
 */
export const IMPORTS_QUEUE = 'imports';
export const IMPORT_ANALYZE_JOB = 'analyze';
export const IMPORT_EXECUTE_JOB = 'execute';
export const IMPORT_CANCEL_JOB = 'cancel';
export const IMPORT_PURGE_JOB = 'purge-files';
export const IMPORT_PURGE_SCHEDULER = 'imports-daily-purge';
export const IMPORT_PURGE_PATTERN = '40 0 * * *';

export interface ImportJobData {
	organizationId: string;
	importJobId: string;
	/** La personne qui a lancé l'action (membre actif revérifié dans la tâche). */
	userId: string;
	/** Annulation : le motif. */
	reason?: string;
}

export interface ImportPurgeJobData {
	/** Instant imposé (tests) ; sinon maintenant. */
	now?: string;
}
