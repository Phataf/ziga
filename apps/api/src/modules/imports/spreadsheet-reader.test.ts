/**
 * Lot 11, étape 3 : lecture d'un fichier envoyé, traité comme hostile (ajout 1 du porteur). Dans la tâche de fond
 * seulement, dans un fil d'exécution à part, sous limites : taille du fichier, taille réelle décompressée (jamais celle
 * annoncée par l'archive), nombre d'onglets, de lignes et de cellules, durée. Valeurs seulement, jamais les formules.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deflatedSpaces, minimalXlsx } from '../../../test/fixtures/imports/zip.js';
import { DEFAULT_IMPORT_LIMITS, ImportFileError, readSpreadsheet, unzipEntries, type ImportLimits } from './spreadsheet-reader.js';

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../../../test/fixtures/imports/${name}`, import.meta.url)));
const limits = (over: Partial<ImportLimits> = {}): ImportLimits => ({ ...DEFAULT_IMPORT_LIMITS, ...over });

async function refusal(promise: Promise<unknown>): Promise<ImportFileError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(ImportFileError);
		return error as ImportFileError;
	}
	throw new Error('Lecture acceptée alors qu’elle devait être refusée');
}

describe('lecture d’un classeur sous limites', () => {
	it('le registre fictif : sept onglets, valeurs typées (texte, nombre, date)', async () => {
		const book = await readSpreadsheet(fixture('registre-fictif.xlsx'), { format: 'xlsx', fileName: 'registre-fictif.xlsx' }, limits());
		expect(book.sheets.map((s) => s.sheet)).toEqual([
			'Propriétaires',
			'Biens',
			'Unités',
			'Locataires',
			'Baux',
			'Cautions',
			'Soldes d’ouverture'
		]);
		const owners = book.sheets[0]!.data;
		expect(owners[1]).toEqual(['Personne', 'P1', 'OUEDRAOGO Mariam', '70 11 22 33', 'mariam.ouedraogo@exemple.test', null, null]);
		// Cellule nombre (téléphone sans mise en forme) et cellule date restent typées.
		expect(owners[3]![3]).toBe(76001122);
		expect(book.sheets[4]!.data.some((r) => r.some((c) => c instanceof Date))).toBe(true);
	});

	it('un fichier CSV (Windows-1252, point-virgule) : un onglet, nommé d’après ses en-têtes', async () => {
		const book = await readSpreadsheet(fixture('registre-fictif-locataires.csv'), { format: 'csv', fileName: 'locataires.csv' }, limits());
		expect(book.sheets).toHaveLength(1);
		expect(book.sheets[0]!.sheet).toBe('Locataires');
		expect(book.sheets[0]!.data[0]).toEqual(['Nom et prénoms', 'Téléphone', 'Civilité', 'Référence du locataire', 'Profession']);
	});

	it('formules : seulement la valeur en cache, jamais la formule ; sans valeur en cache, vide', async () => {
		const xml =
			'<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Loyer</t></is></c><c r="B1" t="inlineStr"><is><t>Double</t></is></c></row>' +
			'<row r="2"><c r="A2"><f>40000+35000</f><v>75000</v></c><c r="B2"><f>A2*2</f></c></row></sheetData>';
		const book = await readSpreadsheet(minimalXlsx('Unités', { xml }), { format: 'xlsx', fileName: 'f.xlsx' }, limits());
		expect(book.sheets[0]!.data[1]).toEqual([75000, null]);
	});
});

describe('fichier hostile : refusé proprement, avec un message en français', () => {
	it('archive qui se décompresse démesurément : refusée sans être décompressée en entier', async () => {
		const bomb = minimalXlsx('Unités', { deflated: deflatedSpaces(64 * 1024 * 1024) });
		expect(bomb.length).toBeLessThan(200_000);
		const started = Date.now();
		const e = await refusal(readSpreadsheet(bomb, { format: 'xlsx', fileName: 'bombe.xlsx' }, limits()));
		expect(e.code).toBe('IMPORT_UNCOMPRESSED_TOO_LARGE');
		expect(e.message).toBe('Fichier refusé : une fois décompressé, il dépasse 50 Mo. Enregistrez-le de nouveau depuis Excel, sans images.');
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it('même archive annonçant une petite taille : la taille réelle compte, pas celle de l’en-tête', async () => {
		const liar = minimalXlsx('Unités', { deflated: deflatedSpaces(64 * 1024 * 1024, 1_000) });
		expect((await refusal(readSpreadsheet(liar, { format: 'xlsx', fileName: 'menteur.xlsx' }, limits()))).code).toBe(
			'IMPORT_UNCOMPRESSED_TOO_LARGE'
		);
	});

	it('fichier trop gros avant même d’être ouvert', async () => {
		const e = await refusal(
			readSpreadsheet(fixture('registre-fictif.xlsx'), { format: 'xlsx', fileName: 'r.xlsx' }, limits({ maxFileBytes: 1_000 }))
		);
		expect(e.code).toBe('IMPORT_FILE_TOO_LARGE');
	});

	it('pas un classeur : refusé', async () => {
		const e = await refusal(readSpreadsheet(Buffer.from('ceci n’est pas un classeur'), { format: 'xlsx', fileName: 'x.xlsx' }, limits()));
		expect(e).toMatchObject({ code: 'IMPORT_UNREADABLE', message: 'Ce fichier n’est pas un classeur Excel (.xlsx) lisible.' });
	});

	it('trop d’onglets, de lignes ou de cellules', async () => {
		const book = fixture('registre-fictif.xlsx');
		const meta = { format: 'xlsx' as const, fileName: 'r.xlsx' };
		expect((await refusal(readSpreadsheet(book, meta, limits({ maxSheets: 3 })))).message).toBe('Le classeur a 7 onglets : 3 au plus.');
		expect((await refusal(readSpreadsheet(book, meta, limits({ maxRows: 10 })))).message).toBe('L’onglet Unités dépasse 10 lignes.');
		expect((await refusal(readSpreadsheet(book, meta, limits({ maxCells: 100 })))).code).toBe('IMPORT_TOO_MANY_CELLS');
	});

	it('analyse trop longue : interrompue', async () => {
		const e = await refusal(
			readSpreadsheet(fixture('registre-fictif.xlsx'), { format: 'xlsx', fileName: 'r.xlsx' }, limits({ timeoutMs: 1 }))
		);
		expect(e).toMatchObject({
			code: 'IMPORT_ANALYSIS_TIMEOUT',
			message: 'Analyse du fichier trop longue : découpez-le en plusieurs fichiers.'
		});
	});
});

describe('lecture des entrées d’une archive (modèle et tests)', () => {
	it('entrées décompressées, sous la même limite', () => {
		const entries = unzipEntries(minimalXlsx('Unités', { xml: '<sheetData/>' }), limits());
		expect([...entries.keys()]).toContain('xl/workbook.xml');
		expect(entries.get('xl/workbook.xml')!.toString('utf8')).toContain('name="Unités"');
	});
});
