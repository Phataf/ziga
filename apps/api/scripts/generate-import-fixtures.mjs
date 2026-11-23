#!/usr/bin/env node
/**
 * Écrit le registre fictif du lot 11 (`test/fixtures/imports/registre-fictif.ts`) :
 * - `registre-fictif.xlsx` : les sept onglets, cellules texte, nombre ou date comme dans un vrai registre ;
 * - `registre-fictif-locataires.csv` : l'onglet Locataires, en Windows-1252 avec point-virgule, comme l'enregistre
 *   Excel en français (« CSV (séparateur : point-virgule) »).
 * - `registre-libre.xlsx` (étape 4b) : le registre libre, une seule feuille (`registre-libre.ts`).
 * Relancer après toute modification des données : `node apps/api/scripts/generate-import-fixtures.mjs`.
 * `registre-fictif.test.ts` vérifie que les fichiers versionnés correspondent aux données.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import writeXlsxFile from 'write-excel-file/node';
import { FREE_SHEET } from '../test/fixtures/imports/registre-libre.ts';
import { REGISTRY_SHEETS, TENANTS } from '../test/fixtures/imports/registre-fictif.ts';

const out = (name) => fileURLToPath(new URL(`../test/fixtures/imports/${name}`, import.meta.url));

/** Cellule de `write-excel-file` : le type de la donnée est gardé (texte, nombre, date). */
function cell(value) {
	if (value === null || value === '') return null;
	if (value instanceof Date) return { value, type: Date, format: 'dd/mm/yyyy' };
	if (typeof value === 'number') return { value, type: Number };
	return { value, type: String };
}

const sheets = REGISTRY_SHEETS.map((s) => ({
	sheet: s.name,
	data: [s.headers.map((h) => ({ value: h, type: String, fontWeight: 'bold' })), ...s.rows.map((r) => r.map(cell))],
	columns: s.headers.map((h) => ({ width: Math.max(12, Math.min(40, h.length + 4)) }))
}));
writeFileSync(out('registre-fictif.xlsx'), await writeXlsxFile(sheets).toBuffer());

// Étape 4b : registre libre, une seule feuille.
writeFileSync(
	out('registre-libre.xlsx'),
	await writeXlsxFile([
		{
			sheet: FREE_SHEET.name,
			data: [FREE_SHEET.headers.map((h) => ({ value: h, type: String, fontWeight: 'bold' })), ...FREE_SHEET.rows.map((r) => r.map(cell))]
		}
	]).toBuffer()
);

/** Windows-1252 : ASCII et Latin-1 sur un octet, plus les quelques signes propres à Windows. */
const CP1252 = new Map([
	['€', 0x80],
	['‚', 0x82],
	['„', 0x84],
	['…', 0x85],
	['‘', 0x91],
	['’', 0x92],
	['“', 0x93],
	['”', 0x94],
	['–', 0x96],
	['—', 0x97],
	['œ', 0x9c],
	['Œ', 0x8c]
]);
function encodeCp1252(text) {
	const bytes = [];
	for (const ch of text) {
		const code = ch.codePointAt(0);
		if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) bytes.push(code);
		else if (CP1252.has(ch)) bytes.push(CP1252.get(ch));
		else throw new Error(`Caractère absent de Windows-1252 : ${ch}`);
	}
	return Uint8Array.from(bytes);
}
const csvCell = (v) => {
	const text = v === null ? '' : String(v);
	return /[;"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const csv = [TENANTS.headers, ...TENANTS.rows].map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
writeFileSync(out('registre-fictif-locataires.csv'), encodeCp1252(csv));

console.log('Registre fictif écrit :', out('registre-fictif.xlsx'), out('registre-fictif-locataires.csv'));
