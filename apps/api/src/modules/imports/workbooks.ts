/**
 * Classeurs écrits par la plateforme (lot 11) avec write-excel-file et son extension des listes déroulantes :
 * - le modèle téléchargeable (prompt §1) : notice, un onglet par type, en-têtes en français, ligne d'exemple, listes
 *   déroulantes vers un onglet « Listes » caché (valeurs du modèle, communes et quartiers du référentiel) ;
 * - le rapport final (prompt §2.5) : cellules neutralisées par `importReportRows` (ajout 2 du porteur), écrites en
 *   texte ou en nombre, jamais en formule.
 */
import dataValidation, { type DataValidationSheetOptions } from '@onparallel/write-excel-file-data-validation';
import { importReportRows, type ImportReportInput } from '@ziga/shared/import-report';
import { importTemplate, type ImportField } from '@ziga/shared/import-template';
import type { OrganizationType } from '@ziga/shared/permissions';
import writeXlsxFile, { type Sheet as WorkbookSheet, type SheetOptions } from 'write-excel-file/node';

type Cell = { value: string | number; type: typeof String | typeof Number; fontWeight?: 'bold'; wrap?: boolean } | null;
type Sheet = SheetOptions<Buffer> & DataValidationSheetOptions & { data: Cell[][] };

const LISTS_SHEET = 'Listes';
/** Lignes du modèle couvertes par les listes déroulantes. */
const TEMPLATE_ROWS = 2_000;

const text = (value: string, bold = false): Cell => ({ value, type: String, ...(bold ? { fontWeight: 'bold' as const } : {}) });
const value = (v: string | number | undefined): Cell =>
	v === undefined || v === '' ? null : typeof v === 'number' ? { value: v, type: Number } : text(v);

/** Onglet « Listes » caché : crochet de write-excel-file sur `xl/workbook.xml`. */
const hideLists = {
	files: {
		transform: {
			'xl/workbook.xml': {
				transformElementAttributes: (tag: string, attributes: Record<string, string | number>) =>
					tag === 'sheet' && attributes.name === LISTS_SHEET ? { ...attributes, state: 'hidden' } : attributes
			}
		}
	}
};

const columnLetter = (index: number): string => {
	let n = index + 1;
	let out = '';
	while (n > 0) {
		const r = (n - 1) % 26;
		out = String.fromCharCode(65 + r) + out;
		n = Math.floor((n - 1) / 26);
	}
	return out;
};

export interface TemplateGeography {
	communes: readonly { id: string; name: string }[];
	neighborhoods: readonly { id: string; communeId: string; name: string }[];
}

export async function writeImportTemplate(type: OrganizationType, geography: TemplateGeography): Promise<Buffer> {
	const sheets = importTemplate(type);
	// Listes : une colonne par liste (libellé en ligne 1, valeurs ensuite).
	const lists: { name: string; values: string[] }[] = [];
	const listOf = (name: string, values: string[]): string => {
		let i = lists.findIndex((l) => l.name === name);
		if (i < 0) {
			lists.push({ name, values });
			i = lists.length - 1;
		}
		const col = columnLetter(i);
		return `${LISTS_SHEET}!$${col}$2:$${col}$${Math.max(2, values.length + 1)}`;
	};
	const rangeFor = (f: ImportField): string | null => {
		if (f.kind === 'boolean') return listOf('Oui ou non', ['Oui', 'Non']);
		if (f.kind === 'choice' && f.choices)
			return listOf(
				f.header,
				f.choices.map((c) => c.label)
			);
		if (f.key === 'commune')
			return listOf(
				'Communes',
				geography.communes.map((c) => c.name)
			);
		if (f.key === 'neighborhood')
			return listOf(
				'Quartiers',
				[...new Set(geography.neighborhoods.map((n) => n.name))].sort((a, b) => a.localeCompare(b, 'fr'))
			);
		return null;
	};

	const notice: Cell[][] = [
		[text('Modèle d’import Ziga', true)],
		[
			text(
				'Remplissez un onglet par type, une ligne par fiche. Les colonnes peuvent être dans un autre ordre ; leurs en-têtes sont reconnus.'
			)
		],
		[text('La deuxième ligne de chaque onglet est un exemple : remplacez-la. Les listes déroulantes proposent les valeurs acceptées.')],
		[
			text(
				'À l’envoi, vous choisissez la date de bascule (le 1er du mois en cours par défaut) : les échéances sont générées à partir d’elle ; ce qui était dû avant va dans l’onglet Soldes d’ouverture.'
			)
		],
		[text('Une ligne en erreur est écartée avec ce qui en dépend ; la prévisualisation dit pourquoi, avant que rien ne soit créé.')],
		[null],
		...sheets.flatMap((s) => [
			[text(s.name, true)],
			[text(s.help)],
			...s.fields.map((f) => [text(`${f.header}${f.required ? ' (obligatoire)' : ''}`), text(f.help)]),
			[null]
		])
	];

	const workbookSheets: Sheet[] = [{ sheet: 'Notice', data: notice, columns: [{ width: 42 }, { width: 110 }] }];
	for (const s of sheets) {
		const validations: NonNullable<DataValidationSheetOptions['dataValidation']> = [];
		s.fields.forEach((f, col) => {
			const range = rangeFor(f);
			if (!range) return;
			validations.push({
				cellRange: { from: { row: 2, column: col + 1 }, to: { row: TEMPLATE_ROWS, column: col + 1 } },
				validation: { type: 'list', valuesRange: range, error: `Choisissez une valeur de la liste « ${f.header} ».` }
			});
		});
		workbookSheets.push({
			sheet: s.name,
			data: [s.fields.map((f) => text(f.header, true)), s.fields.map((f) => value(f.example))],
			columns: s.fields.map((f) => ({ width: Math.max(14, Math.min(36, f.header.length + 4)) })),
			stickyRowsCount: 1,
			dataValidation: validations
		});
	}
	const height = Math.max(...lists.map((l) => l.values.length)) + 1;
	workbookSheets.push({
		sheet: LISTS_SHEET,
		data: Array.from({ length: height }, (_, r) =>
			lists.map((l) => (r === 0 ? text(l.name, true) : l.values[r - 1] ? text(l.values[r - 1]!) : null))
		)
	});
	// L'extension des listes ajoute `dataValidation` aux options d'un onglet ; le type de write-excel-file l'ignore.
	return writeXlsxFile(workbookSheets as unknown as WorkbookSheet<Buffer>[], { features: [dataValidation, hideLists] } as never).toBuffer();
}

export async function writeImportReport(input: ImportReportInput): Promise<Buffer> {
	const rows = importReportRows(input).map((r, i) =>
		r.map((c): Cell => (c === '' ? null : typeof c === 'number' ? { value: c, type: Number } : text(c, i === 0)))
	);
	return writeXlsxFile([
		{
			sheet: 'Rapport',
			data: rows,
			columns: [{ width: 20 }, { width: 8 }, { width: 16 }, { width: 36 }, { width: 110 }],
			stickyRowsCount: 1
		}
	] as unknown as WorkbookSheet<Buffer>[]).toBuffer();
}
