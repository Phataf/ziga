/**
 * PDF d'un reçu de paiement (lot 09), dessiné par pdf-lib (polices standard) : format A6 (105 × 148 mm) et ticket de
 * caisse (58 ou 80 mm de large, hauteur selon le contenu). Le contenu vient de `receiptDocument` (packages/shared),
 * le même que l'écran ; le QR code (uqr, matrice dessinée en carrés) ouvre la page publique de vérification. Un reçu
 * annulé porte « ANNULÉ » en tête et en filigrane (règle 3).
 *
 * Règle 2 : les polices standard (WinAnsi) n'ont pas l'espace fine insécable ; U+00A0 la remplace dans ces PDF
 * seulement (formatFcfaForPdf). Tout autre caractère hors de l'encodage devient « ? » plutôt que de faire échouer le
 * document.
 */
import { NBSP, THIN_NBSP } from '@ziga/shared/money';
import { RECEIPT_CANCELLED_MARK, type ReceiptDocument, type ReceiptFormat, type ReceiptTicketWidth } from '@ziga/shared/receipts';
import { degrees, PDFDocument, rgb, StandardFonts, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { encode } from 'uqr';

const MM = 72 / 25.4;
const A6 = { width: 105 * MM, height: 148 * MM };
const BLACK = rgb(0, 0, 0);
const GREY = rgb(0.35, 0.35, 0.35);
const RED = rgb(0.75, 0.05, 0.05);

export interface ReceiptPdfInput {
	document: ReceiptDocument;
	format: ReceiptFormat;
	ticketWidth: ReceiptTicketWidth;
	/** Logo de l'organisation (PNG du lot 03), version figée à l'émission ; absent : pas de logo. */
	logoPng: Uint8Array | null;
}

type Style = 'regular' | 'bold' | 'italic';

interface Line {
	text: string;
	size: number;
	style: Style;
	align: 'left' | 'center';
	color?: ReturnType<typeof rgb>;
	gapBefore: number;
	/** Décalage depuis la marge (colonne des valeurs, en A6). */
	indent?: number;
	/** Libellé dessiné dans la colonne de gauche, sur la même ligne (A6). */
	label?: { text: string; size: number };
}

interface Fonts {
	regular: PDFFont;
	bold: PDFFont;
	italic: PDFFont;
}

/** Texte encodable par les polices standard : espace fine → espace insécable, le reste hors encodage → « ? ». */
export function pdfSafe(text: string, font: PDFFont): string {
	const normalized = text.replaceAll(THIN_NBSP, NBSP);
	try {
		font.encodeText(normalized);
		return normalized;
	} catch {
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
}

/** Découpe un texte en lignes qui tiennent dans la largeur ; un mot trop long est coupé. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
	const out: string[] = [];
	for (const paragraph of text.split('\n')) {
		let line = '';
		for (const word of paragraph.split(' ')) {
			const candidate = line ? `${line} ${word}` : word;
			if (font.widthOfTextAtSize(candidate, size) <= width) {
				line = candidate;
				continue;
			}
			if (line) out.push(line);
			let rest = word;
			while (font.widthOfTextAtSize(rest, size) > width && rest.length > 1) {
				let cut = rest.length - 1;
				while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut -= 1;
				out.push(rest.slice(0, cut));
				rest = rest.slice(cut);
			}
			line = rest;
		}
		out.push(line);
	}
	return out;
}

function lines(doc: ReceiptDocument, fonts: Fonts, width: number, layout: 'columns' | 'stacked', compact: boolean): Line[] {
	const s = compact ? 0.9 : 1;
	const out: Line[] = [];
	const push = (text: string, size: number, style: Style, align: Line['align'], gapBefore = 0, color?: Line['color'], indent = 0) => {
		const font = fonts[style];
		wrap(pdfSafe(text, font), font, size * s, width - indent).forEach((t, i) =>
			out.push({ text: t, size: size * s, style, align, gapBefore: i === 0 ? gapBefore : 0, indent, ...(color ? { color } : {}) })
		);
	};
	doc.organization.forEach((l, i) => push(l, i === 0 ? 11 : 7.5, i === 0 ? 'bold' : 'regular', 'center', i === 0 ? 0 : 1));
	push(doc.title, 13, 'bold', 'center', 8);
	if (doc.cancelled) push(RECEIPT_CANCELLED_MARK, 15, 'bold', 'center', 3, RED);
	push(`N° ${doc.number}`, 10, 'bold', 'center', 3);
	push(`Émis le ${doc.issuedOn}`, 8, 'regular', 'center', 1, GREY);
	const fields = [...doc.fields, { label: 'En lettres', value: doc.amountInWords }];
	if (layout === 'columns') {
		// A6 : libellé à gauche, valeur à droite, sur la même ligne.
		const indent = width * 0.3;
		for (const field of fields) {
			const values = Array.isArray(field.value) ? field.value : [field.value];
			values.forEach((value, i) => {
				const amount = field.label === 'Montant';
				const style: Style = amount ? 'bold' : field.label === 'En lettres' ? 'italic' : 'regular';
				const start = out.length;
				push(value, amount ? 10.5 : 8.5, style, 'left', i === 0 ? 4 : 0.5, undefined, indent);
				if (i === 0) out[start] = { ...out[start]!, label: { text: pdfSafe(field.label, fonts.bold), size: 7 * s } };
			});
		}
		return out;
	}
	for (const field of fields) {
		push(field.label, 7.5, 'bold', 'left', 6, GREY);
		for (const value of Array.isArray(field.value) ? field.value : [field.value]) {
			const amount = field.label === 'Montant';
			push(value, amount ? 12 : 9, amount ? 'bold' : field.label === 'En lettres' ? 'italic' : 'regular', 'left', 1);
		}
	}
	return out;
}

function lineHeight(l: Line): number {
	return l.size * 1.2 + l.gapBefore;
}

function drawCancelledWatermark(page: PDFPage, font: PDFFont): void {
	const { width, height } = page.getSize();
	const size = Math.min(width, height) / 4;
	const textWidth = font.widthOfTextAtSize(RECEIPT_CANCELLED_MARK, size);
	const textHeight = font.heightAtSize(size, { descender: false });
	// Rotation de 45° autour de l'origine du texte : l'origine est placée pour que le centre du mot soit au centre.
	page.drawText(RECEIPT_CANCELLED_MARK, {
		x: width / 2 - (textWidth / 2) * Math.SQRT1_2 + (textHeight / 2) * Math.SQRT1_2,
		y: height / 2 - (textWidth / 2) * Math.SQRT1_2 - (textHeight / 2) * Math.SQRT1_2,
		size,
		font,
		color: RED,
		opacity: 0.18,
		rotate: degrees(45)
	});
}

/** Matrice du QR code, en carrés noirs, coin inférieur gauche en (x, y). */
function drawQr(page: PDFPage, url: string, x: number, y: number, size: number): void {
	const { data } = encode(url, { ecc: 'M', border: 0 });
	const n = data.length;
	const cell = size / n;
	for (let row = 0; row < n; row += 1) {
		for (let col = 0; col < n; col += 1) {
			if (data[row]![col])
				page.drawRectangle({ x: x + col * cell, y: y + size - (row + 1) * cell, width: cell, height: cell, color: BLACK });
		}
	}
}

export async function renderReceiptPdf(input: ReceiptPdfInput): Promise<Uint8Array> {
	const pdf = await PDFDocument.create();
	pdf.setTitle(`${input.document.title} ${input.document.number}`);
	pdf.setProducer('Ziga');
	pdf.setCreator('Ziga');
	const fonts: Fonts = {
		regular: await pdf.embedFont(StandardFonts.Helvetica),
		bold: await pdf.embedFont(StandardFonts.HelveticaBold),
		italic: await pdf.embedFont(StandardFonts.HelveticaOblique)
	};
	const ticket = input.format === 'ticket';
	const pageWidth = ticket ? input.ticketWidth * MM : A6.width;
	const margin = ticket ? 3 * MM : 7 * MM;
	const contentWidth = pageWidth - 2 * margin;
	const content = lines(input.document, fonts, contentWidth, ticket ? 'stacked' : 'columns', ticket && input.ticketWidth === 58);
	const logo: PDFImage | null = input.logoPng ? await pdf.embedPng(input.logoPng).catch(() => null) : null;
	const logoHeight = logo ? Math.min(32, (logo.height / logo.width) * contentWidth * 0.5) : 0;
	const caption = input.document.verificationUrl
		? wrap(pdfSafe(`Vérifiez ce reçu : ${input.document.verificationUrl}`, fonts.regular), fonts.regular, 5.5, contentWidth)
		: [];
	const body = content.reduce((h, l) => h + lineHeight(l), 0) + (logo ? logoHeight + 6 : 0);
	// A6 : le QR code se réduit (48 points au moins, lisible à l'impression) pour rester sur la même page.
	// Un point de marge contre les arrondis : le QR code ne doit jamais partir seul sur une seconde page.
	const room = A6.height - 2 * margin - body - 12 - caption.length * 7 - 1;
	const qrSize = input.document.verificationUrl ? (ticket ? Math.min(contentWidth * 0.6, 90) : Math.max(48, Math.min(62, room))) : 0;
	const footer = qrSize ? 8 + qrSize + 4 + caption.length * 7 : 0;
	// Ticket : la hauteur suit le contenu (marge de 4 points contre les arrondis).
	const pageHeight = ticket ? body + footer + 2 * margin + 4 : A6.height;

	let page = pdf.addPage([pageWidth, pageHeight]);
	let y = pageHeight - margin;
	if (logo) {
		const w = (logo.width / logo.height) * logoHeight;
		page.drawImage(logo, { x: (pageWidth - w) / 2, y: y - logoHeight, width: w, height: logoHeight });
		y -= logoHeight + 6;
	}
	const pages = [page];
	for (const l of content) {
		if (y - lineHeight(l) < margin) {
			page = pdf.addPage([pageWidth, pageHeight]);
			pages.push(page);
			y = pageHeight - margin;
		}
		y -= lineHeight(l);
		const font = fonts[l.style];
		const textWidth = font.widthOfTextAtSize(l.text, l.size);
		if (l.label) page.drawText(l.label.text, { x: margin, y: y + l.size * 0.25, size: l.label.size, font: fonts.bold, color: GREY });
		page.drawText(l.text, {
			x: l.align === 'center' ? (pageWidth - textWidth) / 2 : margin + (l.indent ?? 0),
			y: y + l.size * 0.25,
			size: l.size,
			font,
			color: l.color ?? BLACK
		});
	}
	if (qrSize && input.document.verificationUrl) {
		if (y - footer < margin) {
			page = pdf.addPage([pageWidth, pageHeight]);
			pages.push(page);
			y = pageHeight - margin;
		}
		y -= 8 + qrSize;
		drawQr(page, input.document.verificationUrl, (pageWidth - qrSize) / 2, y, qrSize);
		y -= 4;
		for (const c of caption) {
			y -= 7;
			const w = fonts.regular.widthOfTextAtSize(c, 5.5);
			page.drawText(c, { x: (pageWidth - w) / 2, y, size: 5.5, font: fonts.regular, color: GREY });
		}
	}
	if (input.document.cancelled) for (const p of pages) drawCancelledWatermark(p, fonts.bold);
	return pdf.save();
}
