/**
 * PDF de l'état des lieux (lot 10 bis, étape 4 ; article 9), dessiné par pdf-lib (polices standard), au format A4 :
 * pièce par pièce, élément par élément, constat et description, photos avec leurs dates (prise sur l'appareil, reçue par
 * le serveur), la mention « Photo reçue après la signature, le … » pour une photo arrivée après elle, et les signatures
 * telles qu'elles sont (« Case cochée par … sur l'appareil de … » ou scan déposé ; jamais une signature électronique).
 * Fonction pure : le contenu vient de l'appelant, testé par inspection-report-pdf.test.ts.
 */
import { NBSP, THIN_NBSP } from '@ziga/shared/money';
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';

const MM = 72 / 25.4;
const PAGE = { width: 210 * MM, height: 297 * MM };
const MARGIN = 16 * MM;
const BLACK = rgb(0, 0, 0);
const GREY = rgb(0.35, 0.35, 0.35);
const ALERT = rgb(0.62, 0.17, 0.1);
const LINE = rgb(0.8, 0.8, 0.8);
const PHOTO_WIDTH = 55 * MM;

export interface InspectionReportPhoto {
	/** JPEG ou PNG ; `null` pour un format que le PDF ne dessine pas (la photo reste citée). */
	image: { bytes: Uint8Array; type: 'image/jpeg' | 'image/png' } | null;
	dates: string;
	/** « Photo reçue après la signature, le … », ou rien. */
	late: string | null;
}

export interface InspectionReportData {
	title: string;
	organizationName: string;
	/** Logement, locataire, date de l'état des lieux… */
	details: string[];
	rooms: {
		name: string;
		items: { element: string; finding: string | null; description: string; photos: InspectionReportPhoto[] }[];
	}[];
	signatures: string[];
	footer: string;
}

/** Texte encodable par les polices standard ; tout autre caractère devient « ? » plutôt que de faire échouer le document. */
function safe(text: string, font: PDFFont): string {
	const normalized = text.replaceAll(THIN_NBSP, NBSP).replaceAll('−', '-');
	let out = '';
	for (const ch of normalized) {
		try {
			font.encodeText(ch);
			out += ch;
		} catch {
			out += '?';
		}
	}
	return out;
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
	const lines: string[] = [];
	for (const paragraph of safe(text, font).split('\n')) {
		let line = '';
		for (const word of paragraph.split(' ')) {
			const next = line ? `${line} ${word}` : word;
			if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
			else {
				lines.push(line);
				line = word;
			}
		}
		lines.push(line);
	}
	return lines;
}

export async function inspectionReportPdf(data: InspectionReportData): Promise<Uint8Array> {
	const pdf = await PDFDocument.create();
	pdf.setTitle(data.title);
	pdf.setProducer('Ziga');
	const regular = await pdf.embedFont(StandardFonts.Helvetica);
	const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
	const width = PAGE.width - 2 * MARGIN;
	let page: PDFPage = pdf.addPage([PAGE.width, PAGE.height]);
	let y = PAGE.height - MARGIN;

	const ensure = (height: number) => {
		if (y - height >= MARGIN + 10) return;
		page = pdf.addPage([PAGE.width, PAGE.height]);
		y = PAGE.height - MARGIN;
	};
	const text = (value: string, opts: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb>; indent?: number } = {}) => {
		const font = opts.font ?? regular;
		const size = opts.size ?? 10;
		for (const line of wrap(value, font, size, width - (opts.indent ?? 0))) {
			ensure(size + 4);
			page.drawText(line, { x: MARGIN + (opts.indent ?? 0), y: y - size, size, font, color: opts.color ?? BLACK });
			y -= size + 4;
		}
	};
	const rule = () => {
		ensure(8);
		page.drawLine({ start: { x: MARGIN, y: y - 3 }, end: { x: MARGIN + width, y: y - 3 }, thickness: 0.5, color: LINE });
		y -= 8;
	};

	text(data.title, { font: bold, size: 16 });
	text(data.organizationName, { font: bold, size: 11 });
	for (const d of data.details) text(d, { color: GREY });
	rule();

	for (const room of data.rooms) {
		y -= 4;
		text(room.name, { font: bold, size: 13 });
		for (const item of room.items) {
			text(item.finding ? `${item.element} — ${item.finding}` : item.element, { font: bold, size: 10, indent: 6 });
			text(item.description, { indent: 6 });
			for (const photo of item.photos) {
				let image: PDFImage | null = null;
				if (photo.image) {
					try {
						image = photo.image.type === 'image/png' ? await pdf.embedPng(photo.image.bytes) : await pdf.embedJpg(photo.image.bytes);
					} catch {
						image = null;
					}
				}
				if (image) {
					const scale = PHOTO_WIDTH / image.width;
					const h = Math.min(image.height * scale, 70 * MM);
					const w = (image.width * h) / image.height;
					ensure(h + 6);
					page.drawImage(image, { x: MARGIN + 12, y: y - h, width: w, height: h });
					y -= h + 4;
				}
				text(photo.dates, { size: 8, color: GREY, indent: 12 });
				if (photo.late) text(photo.late, { font: bold, size: 9, color: ALERT, indent: 12 });
			}
			y -= 4;
		}
		rule();
	}

	y -= 4;
	text('Signatures', { font: bold, size: 13 });
	for (const s of data.signatures) text(s);

	const pages = pdf.getPages();
	pages.forEach((p, i) => {
		const footer = safe(`${data.footer} — page ${i + 1} sur ${pages.length}`, regular);
		p.drawText(footer, { x: MARGIN, y: MARGIN / 2, size: 8, font: regular, color: GREY });
	});
	return pdf.save();
}
