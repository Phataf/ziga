import { describe, expect, it } from 'vitest';
import { importReportRows, neutralizeReportCell, IMPORT_REPORT_HEADERS } from './import-report.js';
import type { ImportIssue } from './import-rows.js';

describe('neutralisation des formules dans le rapport (ajout 2 du porteur)', () => {
	it.each([
		['=HYPERLINK("http://exemple.test","clic")', '\'=HYPERLINK("http://exemple.test","clic")'],
		['+226 70 12 34 56', "'+226 70 12 34 56"],
		['-5 000', "'-5 000"],
		['@SOMME(A1)', "'@SOMME(A1)"],
		['\t=1+1', "'\t=1+1"],
		['\r=1+1', "'\r=1+1"],
		['  =1+1', "'  =1+1"]
	])('« %s » est neutralisé', (input, expected) => {
		expect(neutralizeReportCell(input)).toBe(expected);
	});

	it('un texte ordinaire et un nombre restent tels quels', () => {
		expect(neutralizeReportCell('Kaboré Issouf')).toBe('Kaboré Issouf');
		expect(neutralizeReportCell('Ligne 14 de Baux écartée')).toBe('Ligne 14 de Baux écartée');
		expect(neutralizeReportCell(-5000)).toBe(-5000);
		expect(neutralizeReportCell(14)).toBe(14);
		expect(neutralizeReportCell(null)).toBe('');
	});

	it('chaque cellule du rapport est neutralisée, y compris celles qui viennent du fichier', () => {
		const issues: ImportIssue[] = [
			{
				sheet: 'tenants',
				row: 3,
				field: 'fullName',
				column: 'Nom et prénoms',
				severity: 'error',
				code: 'INVALID',
				message: 'Ligne 3 de Locataires, colonne Nom et prénoms : à remplir.',
				value: "=cmd|' /C calc'!A0"
			}
		];
		const rows = importReportRows({ imported: [{ sheet: 'owners', row: 2, label: '@Ouédraogo' }], issues });
		expect(rows[0]).toEqual([...IMPORT_REPORT_HEADERS]);
		const cells = rows.slice(1).flat();
		for (const cell of cells) {
			if (typeof cell === 'string') expect(cell).not.toMatch(/^\s*[=+\-@\t\r]/);
		}
		expect(rows[1]).toEqual(['Propriétaires', 2, 'Importée', "'@Ouédraogo", '']);
		expect(rows[2]).toEqual([
			'Locataires',
			3,
			'Erreur',
			"'=cmd|' /C calc'!A0",
			'Ligne 3 de Locataires, colonne Nom et prénoms : à remplir.'
		]);
	});

	it('ordre : onglets dans l’ordre d’exécution, puis par ligne ; statut en français', () => {
		const issue = (sheet: ImportIssue['sheet'], row: number, severity: ImportIssue['severity']): ImportIssue => ({
			sheet,
			row,
			field: null,
			column: null,
			severity,
			code: 'X',
			message: 'm',
			value: null
		});
		const rows = importReportRows({
			imported: [{ sheet: 'leases', row: 5, label: 'B-01-A' }],
			issues: [issue('leases', 3, 'skipped'), issue('owners', 9, 'warning'), issue('leases', 2, 'error')]
		});
		expect(rows.slice(1).map((r) => [r[0], r[1], r[2]])).toEqual([
			['Propriétaires', 9, 'Avertissement'],
			['Baux', 2, 'Erreur'],
			['Baux', 3, 'Écartée'],
			['Baux', 5, 'Importée']
		]);
	});
});
