import { describe, expect, it } from 'vitest';
import { decodeImportText, parseCsv } from './import-csv.js';

const bytes = (...values: number[]) => new Uint8Array(values);
const utf8 = (s: string) => new TextEncoder().encode(s);

describe('encodage d’un fichier CSV', () => {
	it('UTF-8, avec ou sans BOM', () => {
		expect(decodeImportText(utf8('Kaboré;Somgandé'))).toBe('Kaboré;Somgandé');
		expect(decodeImportText(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('Nom')]))).toBe('Nom');
	});

	it('Windows-1252 (« CSV séparateur point-virgule » d’Excel en français)', () => {
		// « Kaboré » : é = 0xE9 ; « Société » ; espace insécable 0xA0.
		expect(decodeImportText(bytes(0x4b, 0x61, 0x62, 0x6f, 0x72, 0xe9))).toBe('Kaboré');
		expect(decodeImportText(bytes(0x53, 0x6f, 0x63, 0x69, 0xe9, 0x74, 0xe9))).toBe('Société');
		expect(decodeImportText(bytes(0x37, 0x35, 0xa0, 0x30, 0x30, 0x30))).toBe('75 000');
		// 0x92 : apostrophe typographique de Windows-1252.
		expect(decodeImportText(bytes(0x64, 0x92, 0x69))).toBe('d’i');
	});

	it('UTF-16 avec BOM (« Texte Unicode » d’Excel)', () => {
		expect(decodeImportText(bytes(0xff, 0xfe, 0x4e, 0x00, 0xe9, 0x00))).toBe('Né');
	});
});

describe('lecture d’un CSV', () => {
	it('séparateur point-virgule (Excel en français)', () => {
		expect(parseCsv('Nom;Loyer\nKaboré;75 000\n')).toEqual([
			['Nom', 'Loyer'],
			['Kaboré', '75 000']
		]);
	});

	it('séparateur virgule, et tabulation', () => {
		expect(parseCsv('Nom,Loyer\r\nKaboré,75000')).toEqual([
			['Nom', 'Loyer'],
			['Kaboré', '75000']
		]);
		expect(parseCsv('Nom\tLoyer\nKaboré\t75000')).toEqual([
			['Nom', 'Loyer'],
			['Kaboré', '75000']
		]);
	});

	it('le séparateur est celui de la ligne d’en-tête, hors guillemets', () => {
		expect(parseCsv('"Nom, prénom";Loyer\n"Kaboré, Issouf";"75,000"')).toEqual([
			['Nom, prénom', 'Loyer'],
			['Kaboré, Issouf', '75,000']
		]);
	});

	it('guillemets doublés, retours à la ligne dans une cellule', () => {
		expect(parseCsv('Note;Nom\n"Dit ""le grand""";"Ligne 1\nLigne 2"')).toEqual([
			['Note', 'Nom'],
			['Dit "le grand"', 'Ligne 1\nLigne 2']
		]);
	});

	it('lignes vides de fin ignorées ; lignes vides du milieu gardées (numéros de ligne exacts)', () => {
		expect(parseCsv('A;B\n1;2\n\n3;4\n\n\n')).toEqual([['A', 'B'], ['1', '2'], [''], ['3', '4']]);
	});

	it('cellules vides et ligne plus courte que l’en-tête', () => {
		expect(parseCsv('A;B;C\n1;;3\n4')).toEqual([['A', 'B', 'C'], ['1', '', '3'], ['4']]);
	});

	it('un texte qui commence par « = » reste un texte', () => {
		expect(parseCsv('A\n=SOMME(B1)')).toEqual([['A'], ['=SOMME(B1)']]);
	});

	it('fichier vide', () => {
		expect(parseCsv('')).toEqual([]);
	});
});
