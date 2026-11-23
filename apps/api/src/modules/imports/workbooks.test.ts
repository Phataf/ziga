/**
 * Lot 11, étape 3 : classeurs écrits par la plateforme.
 * - Modèle téléchargeable (prompt §1) : notice, un onglet par type, en-têtes en français, ligne d'exemple, listes
 *   déroulantes vers un onglet « Listes » caché (quartiers du référentiel compris).
 * - Rapport final (prompt §2.5, ajout 2 du porteur) : chaque cellule qui commence par « = », « + », « - » ou « @ » est
 *   neutralisée, pour qu'aucune formule ne s'exécute à la réouverture dans Excel.
 */
import { importTemplate } from '@ziga/shared/import-template';
import readXlsxFile from 'read-excel-file/node';
import { describe, expect, it } from 'vitest';
import { DEFAULT_IMPORT_LIMITS, unzipEntries } from './spreadsheet-reader.js';
import { writeImportReport, writeImportTemplate } from './workbooks.js';

const geography = {
	communes: [
		{ id: 'ouagadougou', name: 'Ouagadougou' },
		{ id: 'saaba', name: 'Saaba' }
	],
	neighborhoods: [
		{ id: 'nb-1', communeId: 'ouagadougou', name: 'Tampouy' },
		{ id: 'nb-2', communeId: 'ouagadougou', name: 'Somgandé' },
		{ id: 'nb-3', communeId: 'saaba', name: 'Tabtenga' }
	]
};

describe('modèle Excel téléchargeable', () => {
	it('agence : notice, sept onglets, listes cachées ; en-têtes du modèle et ligne d’exemple', async () => {
		const book = await writeImportTemplate('agency', geography);
		const sheets = await readXlsxFile(book);
		expect(sheets.map((s) => s.sheet)).toEqual([
			'Notice',
			'Propriétaires',
			'Biens',
			'Unités',
			'Locataires',
			'Baux',
			'Cautions',
			'Soldes d’ouverture',
			'Listes'
		]);
		for (const def of importTemplate('agency')) {
			const data = sheets.find((s) => s.sheet === def.name)!.data;
			expect(data[0], def.name).toEqual(def.fields.map((f) => f.header));
			// Ligne d'exemple : chaque colonne obligatoire est remplie.
			def.fields.forEach((f, i) => {
				if (f.required) expect(data[1]![i], `${def.name} : ${f.header}`).not.toBeNull();
			});
		}
		const notice = sheets[0]!.data.flat().join(' ');
		expect(notice).toContain('date de bascule');
		const lists = sheets.at(-1)!.data.flat();
		expect(lists).toEqual(expect.arrayContaining(['Tampouy', 'Somgandé', 'Tabtenga', 'Gestion locative', 'Groupe d’indivisaires']));
	});

	it('l’onglet « Listes » est caché ; les colonnes à choix ont leur liste déroulante', async () => {
		const entries = unzipEntries(await writeImportTemplate('agency', geography), DEFAULT_IMPORT_LIMITS);
		const workbook = entries.get('xl/workbook.xml')!.toString('utf8');
		expect(workbook).toMatch(/<sheet [^>]*name="Listes"[^>]*state="hidden"/);
		// Onglet Biens (3e) : type de bien, quartier, type de mandat, publication autorisée…
		const properties = entries.get('xl/worksheets/sheet3.xml')!.toString('utf8');
		const lists = [...properties.matchAll(/<dataValidation [^>]*type="list"/g)];
		expect(lists.length).toBeGreaterThanOrEqual(5);
		expect(properties).toContain('Listes!');
	});

	it('bailleur particulier : six onglets, sans Propriétaires ni mandat', async () => {
		const sheets = await readXlsxFile(await writeImportTemplate('landlord', geography));
		expect(sheets.map((s) => s.sheet)).toEqual([
			'Notice',
			'Biens',
			'Unités',
			'Locataires',
			'Baux',
			'Cautions',
			'Soldes d’ouverture',
			'Listes'
		]);
		expect(sheets.find((s) => s.sheet === 'Biens')!.data[0]).not.toContain('Type de mandat');
	});
});

describe('rapport final', () => {
	it('en-tête, lignes dans l’ordre ; toute cellule qui ressemblerait à une formule est neutralisée', async () => {
		const book = await writeImportReport({
			imported: [
				{ sheet: 'tenants', row: 2, label: '=HYPERLINK("http://exemple.test","clic")' },
				{ sheet: 'owners', row: 2, label: 'Ouédraogo Mariam' }
			],
			issues: [
				{
					sheet: 'leases',
					row: 4,
					field: 'rent',
					column: 'Loyer mensuel (FCFA)',
					severity: 'error',
					code: 'INVALID',
					message: 'Ligne 4 de Baux, colonne Loyer mensuel (FCFA) : montant en chiffres attendu, par exemple 75 000.',
					value: '-5000'
				},
				{
					sheet: 'tenants',
					row: 3,
					field: null,
					column: null,
					severity: 'warning',
					code: 'X',
					message: '@avertissement',
					value: '+22670123456'
				}
			]
		});
		const [report] = await readXlsxFile(book);
		expect(report!.sheet).toBe('Rapport');
		expect(report!.data[0]).toEqual(['Onglet', 'Ligne', 'Statut', 'Élément', 'Message']);
		expect(report!.data.slice(1)).toEqual([
			['Propriétaires', 2, 'Importée', 'Ouédraogo Mariam', null],
			['Locataires', 2, 'Importée', '\'=HYPERLINK("http://exemple.test","clic")', null],
			['Locataires', 3, 'Avertissement', "'+22670123456", "'@avertissement"],
			['Baux', 4, 'Erreur', "'-5000", 'Ligne 4 de Baux, colonne Loyer mensuel (FCFA) : montant en chiffres attendu, par exemple 75 000.']
		]);
		// Aucune cellule de type formule dans le fichier écrit.
		const sheet = unzipEntries(book, DEFAULT_IMPORT_LIMITS).get('xl/worksheets/sheet1.xml')!.toString('utf8');
		expect(sheet).not.toContain('<f>');
	});
});
