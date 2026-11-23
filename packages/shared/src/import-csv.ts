/**
 * Import Excel (lot 11) : lecture d'un fichier `.csv`, que les bibliothèques Excel retenues ne lisent pas.
 * - Encodage : UTF-8 (avec ou sans BOM), UTF-16 avec BOM (« Texte Unicode » d'Excel), sinon Windows-1252, celui du
 *   « CSV (séparateur : point-virgule) » d'Excel en français.
 * - Séparateur : celui de la ligne d'en-tête, hors guillemets (point-virgule, virgule ou tabulation).
 * - Guillemets doublés et retours à la ligne dans une cellule (RFC 4180). Toute cellule reste un texte : une formule
 *   n'est jamais évaluée. Fonctions pures.
 */

/** `TextDecoder`, présent dans le navigateur et dans Node (le paquet ne charge ni les types du DOM ni ceux de Node). */
interface Decoder {
	decode(input: Uint8Array): string;
}
const TextDecoder = (globalThis as unknown as { TextDecoder: new (label: string, options?: { fatal?: boolean }) => Decoder }).TextDecoder;

export function decodeImportText(bytes: Uint8Array): string {
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		// Pas de l'UTF-8 valide : Windows-1252 (chaque octet est un caractère, jamais d'échec).
		return new TextDecoder('windows-1252').decode(bytes);
	}
}

const DELIMITERS = [';', ',', '\t'] as const;

/** Séparateur le plus fréquent hors guillemets sur la première ligne ; point-virgule à égalité. */
function detectDelimiter(text: string): string {
	const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (c === '"') quoted = !quoted;
		else if (!quoted && (c === '\n' || c === '\r')) break;
		else if (!quoted && counts.has(c)) counts.set(c, counts.get(c)! + 1);
	}
	let best: string = ';';
	for (const d of DELIMITERS) if (counts.get(d)! > counts.get(best)!) best = d;
	return best;
}

/** Lignes et cellules d'un CSV ; les lignes vides de fin sont retirées, celles du milieu gardées (numéros exacts). */
export function parseCsv(text: string): string[][] {
	if (!text) return [];
	const delimiter = detectDelimiter(text);
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = '';
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (quoted) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					cell += '"';
					i++;
				} else {
					quoted = false;
				}
			} else {
				cell += c;
			}
			continue;
		}
		if (c === '"' && cell === '') {
			quoted = true;
		} else if (c === delimiter) {
			row.push(cell);
			cell = '';
		} else if (c === '\n' || c === '\r') {
			if (c === '\r' && text[i + 1] === '\n') i++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = '';
		} else {
			cell += c;
		}
	}
	if (cell !== '' || row.length) {
		row.push(cell);
		rows.push(row);
	}
	while (rows.length && rows[rows.length - 1]!.every((c) => c === '')) rows.pop();
	return rows.map((r) => (r.every((c) => c === '') ? [''] : r));
}
