/**
 * Import Excel (lot 11) : schémas des routes de l'API et vues renvoyées à l'écran. Les règles de l'import sont dans
 * `import-*.ts` ; la base (migration 0025) applique les siennes.
 */
import { z } from 'zod';
import { isIsoDate } from './dates.js';
import { idSchema } from './ids.js';
import type { ImportBlocker, MatchProposal, PlaceResolution, ImportPlan } from './import-plan.js';
import type { ImportIssue } from './import-rows.js';
import { IMPORT_SHEET_KEYS, type ColumnIssue, type ImportSheetKey } from './import-template.js';

/** Fichier envoyé : 5 Mo au plus (un registre de plusieurs milliers de lignes tient en moins d'1 Mo). */
export const IMPORT_MAX_FILE_BYTES = 5 * 1024 * 1024;

export const IMPORT_FILE_FORMATS = ['xlsx', 'csv'] as const;
export type ImportFileFormat = (typeof IMPORT_FILE_FORMATS)[number];

export const IMPORT_MIME_TYPES: Record<ImportFileFormat, string> = {
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	csv: 'text/csv'
};

const isoDate = z.string().refine(isIsoDate, { error: 'Date invalide.' });

export const createImportSchema = z.object({
	id: idSchema,
	fileName: z.string().trim().min(1, { error: 'Indiquez le nom du fichier.' }).max(255, { error: 'Nom de fichier trop long.' }),
	fileFormat: z.enum(IMPORT_FILE_FORMATS, { error: 'Fichier .xlsx ou .csv attendu.' }),
	fileSize: z
		.number()
		.int()
		.min(1, { error: 'Fichier vide.' })
		.max(IMPORT_MAX_FILE_BYTES, { error: 'Fichier trop volumineux : 5 Mo au plus.' }),
	switchOn: isoDate
});
export type CreateImportData = z.output<typeof createImportSchema>;

export const importChoicesSchema = z.object({
	places: z.record(z.string().max(300), idSchema.nullable()).default({}),
	matches: z.record(z.string().max(60), idSchema.nullable()).default({}),
	depositReceived: z.enum(['full', 'to_complete']).optional()
});
export type ImportChoices = z.output<typeof importChoicesSchema>;

/** Correspondance des colonnes choisie à la main (fichier libre, étape 4b) : onglet → champ → colonne. */
export const importMappingSchema = z.record(z.enum(IMPORT_SHEET_KEYS), z.record(z.string().max(60), z.number().int().min(0).max(500)));
export type ImportMapping = z.output<typeof importMappingSchema>;

export const analyzeImportSchema = z.object({
	switchOn: isoDate.optional(),
	choices: importChoicesSchema.optional(),
	mapping: importMappingSchema.optional()
});
export type AnalyzeImportData = z.output<typeof analyzeImportSchema>;

export const cancelImportSchema = z.object({
	reason: z.string().trim().min(3, { error: 'Indiquez le motif.' }).max(500, { error: 'Motif trop long.' })
});

export type ImportJobStatus = 'uploaded' | 'analyzing' | 'analyzed' | 'analysis_failed' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ImportSheetPreview {
	key: ImportSheetKey;
	name: string;
	/** Lignes non vides. */
	rows: number;
	columns: { field: string; header: string; index: number }[];
	planned: number;
	errors: number;
	skipped: number;
	warnings: number;
}

/** Prévisualisation : ce que l'exécution fera, ligne par ligne, et ce qui l'empêche encore. */
export interface ImportPreview {
	sheets: ImportSheetPreview[];
	unknownSheets: string[];
	columnIssues: ColumnIssue[];
	issues: ImportIssue[];
	blockers: ImportBlocker[];
	pending: ImportPlan['pending'];
	places: PlaceResolution[];
	matches: MatchProposal[];
	summary: ImportPlan['summary'];
}

export type ImportSheetOutcome = 'done' | 'failed' | 'not_run';

export interface ImportReportView {
	sheets: Partial<Record<ImportSheetKey, { status: ImportSheetOutcome; created: number; message: string | null }>>;
	/** Rapport téléchargeable (classeur) prêt. */
	file: boolean;
}

export interface ImportJobView {
	id: string;
	status: ImportJobStatus;
	fileName: string;
	fileFormat: ImportFileFormat;
	switchOn: string;
	createdAt: string;
	createdBy: string;
	startedAt: string | null;
	completedAt: string | null;
	cancelledAt: string | null;
	cancellationReason: string | null;
	/** Analyse ou exécution refusée : le message, en français. */
	error: string | null;
	fileDeletedAt: string | null;
	/** Fin du délai d'annulation (24 heures), tant qu'il court. */
	cancellableUntil: string | null;
	choices: ImportChoices;
	preview: ImportPreview | null;
	report: ImportReportView | null;
}
