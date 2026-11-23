/**
 * Import Excel (lot 11) : lecture des lignes d'un onglet, champ par champ, avec les messages d'erreur. Chaque message
 * dit la ligne, la colonne et quoi corriger, en français simple (critère d'acceptation du prompt) :
 * « Ligne 14 de Locataires, colonne Téléphone : 8 chiffres attendus, par exemple 70 12 34 56. »
 * Les numéros de ligne sont ceux d'Excel (en-tête en ligne 1) ; une ligne vide est ignorée sans décaler les suivantes.
 */
import {
	importText,
	parseImportAmount,
	parseImportBoolean,
	parseImportChoice,
	parseImportDate,
	parseImportInteger,
	parseImportPercent,
	parseImportPhone,
	type CellValue,
	type Parsed
} from './import-values.js';
import {
	IMPORT_SHEET_NAMES,
	type ImportField,
	type ImportSheetDefinition,
	type ImportSheetInput,
	type ImportSheetKey
} from './import-template.js';

export type { CellValue } from './import-values.js';
export type { ImportSheetInput } from './import-template.js';

/**
 * - `error` : la ligne elle-même est fausse ; elle est écartée.
 * - `skipped` : la ligne est écartée parce que ce dont elle dépend l'est (cascade), ou ignorée (bail terminé).
 * - `warning` : la ligne est importée ; quelque chose mérite d'être vérifié.
 */
export type ImportSeverity = 'error' | 'skipped' | 'warning';

export interface ImportIssue {
	sheet: ImportSheetKey;
	row: number;
	field: string | null;
	column: string | null;
	severity: ImportSeverity;
	code: string;
	message: string;
	/** Valeur de la cellule en cause, pour le rapport. */
	value: CellValue | null;
}

export interface ImportRow {
	row: number;
	/** Valeurs lues, par champ (null : vide). */
	values: Record<string, unknown>;
	/** Cellules d'origine, par champ. */
	cells: Record<string, CellValue>;
}

export const REQUIRED_MESSAGE = 'à remplir.';

export function issueMessage(sheet: ImportSheetKey, row: number, column: string | null, text: string): string {
	return column
		? `Ligne ${row} de ${IMPORT_SHEET_NAMES[sheet]}, colonne ${column} : ${text}`
		: `Ligne ${row} de ${IMPORT_SHEET_NAMES[sheet]} : ${text}`;
}

export function makeIssue(
	sheet: ImportSheetKey,
	row: number,
	field: ImportField | null,
	severity: ImportSeverity,
	code: string,
	text: string,
	value: CellValue | null = null
): ImportIssue {
	return {
		sheet,
		row,
		field: field?.key ?? null,
		column: field?.header ?? null,
		severity,
		code,
		message: issueMessage(sheet, row, field?.header ?? null, text),
		value
	};
}

const isBlankCell = (v: CellValue | undefined) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

function parseField(field: ImportField, cell: CellValue | undefined): Parsed<unknown> {
	switch (field.kind) {
		case 'text':
		case 'reference': {
			const text = importText(cell);
			if (text && field.maxLength && text.length > field.maxLength)
				return { error: `texte trop long : ${field.maxLength} caractères au plus.` };
			return { value: text };
		}
		case 'amount':
			return parseImportAmount(cell);
		case 'phone':
			return parseImportPhone(cell);
		case 'date':
			return parseImportDate(cell);
		case 'integer':
			return parseImportInteger(cell, field.min ?? 0, field.max ?? 1_000_000);
		case 'percent':
			return parseImportPercent(cell);
		case 'boolean':
			return parseImportBoolean(cell);
		case 'choice':
			return parseImportChoice(cell, field.choices ?? []);
	}
}

export interface ReadRowsOptions {
	/** Message propre à un champ, à la place du message générique d'une erreur donnée. */
	messages?: Record<string, Record<string, string>>;
}

/** Lignes non vides d'un onglet, lues champ par champ ; une ligne avec une erreur a au moins un `issues` d'erreur. */
export function readImportRows(
	def: ImportSheetDefinition,
	input: ImportSheetInput,
	options: ReadRowsOptions = {}
): { rows: ImportRow[]; issues: ImportIssue[] } {
	const rows: ImportRow[] = [];
	const issues: ImportIssue[] = [];
	input.rows.forEach((cells, index) => {
		if (index === 0) return;
		if (cells.every(isBlankCell)) return;
		const row = index + 1;
		const values: Record<string, unknown> = {};
		const kept: Record<string, CellValue> = {};
		for (const field of def.fields) {
			const col = input.columns[field.key];
			const cell = col === undefined ? null : (cells[col] ?? null);
			kept[field.key] = cell;
			if (isBlankCell(cell)) {
				values[field.key] = null;
				if (field.required) issues.push(makeIssue(def.key, row, field, 'error', 'REQUIRED', REQUIRED_MESSAGE, cell));
				continue;
			}
			const parsed = parseField(field, cell);
			if ('error' in parsed) {
				const text = options.messages?.[field.key]?.[parsed.error] ?? parsed.error;
				issues.push(makeIssue(def.key, row, field, 'error', 'INVALID', text, cell));
				values[field.key] = null;
			} else {
				values[field.key] = parsed.value;
			}
		}
		rows.push({ row, values, cells: kept });
	});
	return { rows, issues };
}
