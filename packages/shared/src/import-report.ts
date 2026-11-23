/**
 * Import Excel (lot 11) : rapport final téléchargeable (lignes importées, écartées, erreurs et avertissements).
 *
 * Neutralisation (ajout 2 du porteur) : une cellule qui commence par « = », « + », « - » ou « @ » (ou par une
 * tabulation ou un retour chariot) serait lue comme une formule à la réouverture dans Excel ; elle est préfixée d'une
 * apostrophe, qui la garde en texte. Toutes les cellules de texte du rapport passent par là, y compris les valeurs
 * venues du fichier envoyé. Un nombre reste un nombre.
 */
import type { CellValue } from './import-values.js';
import { IMPORT_SHEET_KEYS, IMPORT_SHEET_NAMES, type ImportSheetKey } from './import-template.js';
import type { ImportIssue, ImportSeverity } from './import-rows.js';

const FORMULA_START = /^\s*[=+\-@\t\r]/;

export function neutralizeReportCell(v: CellValue | undefined): string | number {
	if (v === null || v === undefined) return '';
	if (typeof v === 'number') return v;
	const text = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
	return FORMULA_START.test(text) ? `'${text}` : text;
}

export const IMPORT_REPORT_HEADERS = ['Onglet', 'Ligne', 'Statut', 'Élément', 'Message'] as const;

const STATUS_LABELS: Record<ImportSeverity | 'imported', string> = {
	imported: 'Importée',
	error: 'Erreur',
	skipped: 'Écartée',
	warning: 'Avertissement'
};

export interface ImportReportInput {
	/** Lignes créées (ou rattachées à une fiche existante), avec un libellé court. */
	imported: readonly { sheet: ImportSheetKey; row: number; label: string }[];
	issues: readonly ImportIssue[];
}

/** Lignes du rapport, en-tête comprise ; onglets dans l'ordre d'exécution, puis par ligne. */
export function importReportRows(input: ImportReportInput): (string | number)[][] {
	type Line = { sheet: ImportSheetKey; row: number; status: ImportSeverity | 'imported'; element: CellValue; message: string };
	const lines: Line[] = [
		...input.issues.map((i) => ({ sheet: i.sheet, row: i.row, status: i.severity, element: i.value, message: i.message })),
		...input.imported.map((i) => ({ sheet: i.sheet, row: i.row, status: 'imported' as const, element: i.label, message: '' }))
	];
	const order = (k: ImportSheetKey) => IMPORT_SHEET_KEYS.indexOf(k);
	lines.sort((a, b) => order(a.sheet) - order(b.sheet) || a.row - b.row);
	return [
		[...IMPORT_REPORT_HEADERS],
		...lines.map((l) => [
			neutralizeReportCell(IMPORT_SHEET_NAMES[l.sheet]),
			l.row,
			neutralizeReportCell(STATUS_LABELS[l.status]),
			neutralizeReportCell(l.element),
			neutralizeReportCell(l.message)
		])
	];
}
