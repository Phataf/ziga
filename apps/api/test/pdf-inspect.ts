/**
 * Lecture d'un PDF de reçu (lot 09) dessiné par pdf-lib : texte de chaque page (chaînes hexadécimales en WinAnsi) et
 * matrice du QR code reconstruite à partir de ses carrés noirs. Sert à vérifier que le QR code imprimé encode bien
 * l'adresse de la page de vérification, sans décodeur d'image.
 */
import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream } from 'pdf-lib';

export interface InspectedPdf {
	pages: { width: number; height: number; text: string[] }[];
	/** Matrice du QR code de la dernière page qui en a un, ligne par ligne, du haut vers le bas. */
	qr: boolean[][] | null;
}

const WIN_ANSI_EXTRA: Record<number, string> = { 0x92: '’', 0x96: '–', 0x97: '—', 0x85: '…', 0x80: '€', 0x9c: 'œ' };

function decodeHex(hex: string): string {
	let out = '';
	for (let i = 0; i < hex.length; i += 2) {
		const byte = Number.parseInt(hex.slice(i, i + 2), 16);
		out += WIN_ANSI_EXTRA[byte] ?? String.fromCharCode(byte);
	}
	return out;
}

export async function inspectPdf(bytes: Uint8Array): Promise<InspectedPdf> {
	const pdf = await PDFDocument.load(bytes);
	const pages: InspectedPdf['pages'] = [];
	let qr: boolean[][] | null = null;
	for (const page of pdf.getPages()) {
		const contents = page.node.Contents();
		const streams = contents instanceof PDFArray ? contents.asArray().map((r) => pdf.context.lookup(r)) : [contents];
		const content = streams.map((s) => Buffer.from(decodePDFRawStream(s as PDFRawStream).decode()).toString('latin1')).join('\n');
		const text = [...content.matchAll(/<([0-9A-Fa-f]*)> Tj/g)].map((m) => decodeHex(m[1]!));
		const cells = [...content.matchAll(/1 0 0 1 ([\d.-]+) ([\d.-]+) cm\n1 0 0 1 0 0 cm\n1 0 0 1 0 0 cm\n0 0 m\n0 ([\d.]+) l/g)].map(
			(m) => ({
				x: Number(m[1]),
				y: Number(m[2]),
				s: Number(m[3])
			})
		);
		if (cells.length) {
			const s = cells[0]!.s;
			const minX = Math.min(...cells.map((c) => c.x));
			const top = Math.max(...cells.map((c) => c.y)) + s;
			const pos = cells.map((c) => ({ col: Math.round((c.x - minX) / s), row: Math.round((top - c.y - s) / s) }));
			const n = Math.max(...pos.map((p) => Math.max(p.col, p.row))) + 1;
			const grid = Array.from({ length: n }, () => Array.from({ length: n }, () => false));
			for (const p of pos) grid[p.row]![p.col] = true;
			qr = grid;
		}
		const { width, height } = page.getSize();
		pages.push({ width, height, text });
	}
	return { pages, qr };
}
