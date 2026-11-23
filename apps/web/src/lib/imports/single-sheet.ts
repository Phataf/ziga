/**
 * Fichier libre sur une seule feuille (lot 11, étape 4b) : état de l'écran de correspondance des colonnes. Les règles
 * (champs proposés, obligatoires, suggestions) sont dans `@ziga/shared/import-single-sheet`.
 */
import type { SingleSheetMapping } from '@ziga/shared/import-single-sheet';
import type { ImportJobView } from '@ziga/shared/imports';

/** Correspondance à proposer : aucun onglet du modèle reconnu, ou une correspondance déjà faite (pour la reprendre). */
export function freeFileNeeded(job: Pick<ImportJobView, 'preview' | 'mapping'>): boolean {
	if (job.mapping?.single) return true;
	return !!job.preview && job.preview.sheets.length === 0 && (job.preview.fileSheets?.length ?? 0) > 0;
}

/** Point de départ : la correspondance déjà faite, sinon les suggestions de la première feuille du fichier. */
export function initialSingleMapping(job: Pick<ImportJobView, 'preview' | 'mapping'>, sheet?: string): SingleSheetMapping {
	const done = job.mapping?.single;
	if (done && (!sheet || done.sheet === sheet))
		return { sheet: done.sheet, columns: { ...done.columns }, constants: { ...done.constants } };
	const file = job.preview?.fileSheets.find((s) => !sheet || s.name === sheet) ?? job.preview?.fileSheets[0];
	return { sheet: file?.name ?? sheet ?? '', columns: { ...(file?.suggested ?? {}) }, constants: {} };
}

/** Une colonne pour un champ : elle remplace sa valeur commune ; `null` retire la colonne. */
export function withColumn(m: SingleSheetMapping, target: string, column: number | null): SingleSheetMapping {
	const columns = { ...m.columns };
	const constants = { ...m.constants };
	if (column === null) {
		delete columns[target];
	} else {
		columns[target] = column;
		delete constants[target];
	}
	return { ...m, columns, constants };
}

/** Une valeur commune pour un champ : elle remplace sa colonne ; vide, elle est retirée. */
export function withConstant(m: SingleSheetMapping, target: string, value: string): SingleSheetMapping {
	const columns = { ...m.columns };
	const constants = { ...m.constants };
	if (value.trim() === '') {
		delete constants[target];
	} else {
		constants[target] = value;
		delete columns[target];
	}
	return { ...m, columns, constants };
}
