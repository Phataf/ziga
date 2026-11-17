/**
 * PDF d'un relevé propriétaire (lot 10), dessiné par pdf-lib (polices standard), au format A4. Le contenu vient de
 * `statementDocument` (packages/shared), le même que l'écran et la page partagée `/s/<jeton>` : un locataire n'y
 * apparaît que par son nom. Montants signés par `formatSignedFcfaForPdf` (ni U+202F ni U+2212 dans WinAnsi).
 */
import { formatFcfaForPdf, formatSignedFcfaForPdf, NBSP, THIN_NBSP } from '@ziga/shared/money';
import type { StatementDocument, StatementSection } from '@ziga/shared/statements';
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';

const MM = 72 / 25.4;
const PAGE = { width: 210 * MM, height: 297 * MM };
const MARGIN = 16 * MM;
const BLACK = rgb(0, 0, 0);
const GREY = rgb(0.35, 0.35, 0.35);
const LINE = rgb(0.8, 0.8, 0.8);

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
	const out: string[] = [];
	let line = '';
	for (const word of text.split(' ')) {
		const candidate = line ? `${line} ${word}` : word;
		if (font.widthOfTextAtSize(candidate, size) <= width || !line) line = candidate;
		else {
			out.push(line);
			line = word;
		}
	}
	if (line) out.push(line);
	return out;
}

export async function renderStatementPdf(doc: StatementDocument): Promise<Buffer> {
	const pdf = await PDFDocument.create();
	pdf.setTitle(doc.title);
	pdf.setProducer('Ziga');
	const regular = await pdf.embedFont(StandardFonts.Helvetica);
	const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
	let page: PDFPage = pdf.addPage([PAGE.width, PAGE.height]);
	let y = PAGE.height - MARGIN;
	const width = PAGE.width - 2 * MARGIN;
	const amountColumn = 38 * MM;

	const ensure = (height: number) => {
		if (y - height < MARGIN) {
			page = pdf.addPage([PAGE.width, PAGE.height]);
			y = PAGE.height - MARGIN;
		}
	};
	const text = (t: string, opts: { size: number; font?: PDFFont; color?: ReturnType<typeof rgb>; gap?: number; maxWidth?: number }) => {
		const font = opts.font ?? regular;
		const rows = wrap(safe(t, font), font, opts.size, opts.maxWidth ?? width);
		y -= opts.gap ?? 0;
		for (const r of rows) {
			ensure(opts.size * 1.3);
			y -= opts.size * 1.3;
			page.drawText(r, { x: MARGIN, y, size: opts.size, font, color: opts.color ?? BLACK });
		}
	};
	const row = (title: string, detail: string | undefined, amount: number, emphasis = false) => {
		const font = emphasis ? bold : regular;
		const titleRows = wrap(safe(title, font), font, 9.5, width - amountColumn);
		const detailRows = detail ? wrap(safe(detail, regular), regular, 8, width - amountColumn) : [];
		ensure(titleRows.length * 12.5 + detailRows.length * 10.5 + 4);
		y -= 3;
		titleRows.forEach((r, i) => {
			y -= 12.5;
			page.drawText(r, { x: MARGIN, y, size: 9.5, font });
			if (i === 0) {
				const value = safe(formatSignedFcfaForPdf(amount), font);
				page.drawText(value, { x: MARGIN + width - font.widthOfTextAtSize(value, 9.5), y, size: 9.5, font });
			}
		});
		for (const r of detailRows) {
			y -= 10.5;
			page.drawText(r, { x: MARGIN, y, size: 8, font: regular, color: GREY });
		}
	};
	const section = (s: StatementSection) => {
		ensure(40);
		text(s.title, { size: 11.5, font: bold, gap: 10 });
		y -= 3;
		page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + width, y }, thickness: 0.6, color: LINE });
		if (!s.rows.length) text('Aucun mouvement.', { size: 9, color: GREY, gap: 2 });
		for (const r of s.rows) row(r.title, r.detail, r.amount);
		if (s.total) row(s.total.label, undefined, s.total.amount, true);
		if (s.note) text(s.note, { size: 8, color: GREY, gap: 3 });
	};

	doc.organization.forEach((l, i) => text(l, { size: i === 0 ? 13 : 8.5, font: i === 0 ? bold : regular, color: i === 0 ? BLACK : GREY }));
	text(doc.title, { size: 16, font: bold, gap: 14 });
	if (doc.draft) text('BROUILLON — non émis', { size: 10, font: bold, color: GREY, gap: 2 });
	text(`Propriétaire : ${doc.owner}`, { size: 10, gap: 6 });
	text(doc.period, { size: 9.5, color: GREY });

	// Cadre de synthèse : jamais un montant négatif, toujours un libellé.
	const h = doc.headline;
	ensure(60);
	y -= 12;
	const boxTop = y;
	text(`${h.label} : ${formatFcfaForPdf(h.amount)}`, { size: 13, font: bold, gap: 8, maxWidth: width - 16 });
	if (h.explanation) text(h.explanation, { size: 8.5, color: GREY, gap: 3, maxWidth: width - 16 });
	y -= 8;
	page.drawRectangle({ x: MARGIN - 6, y, width: width + 12, height: boxTop - y, borderColor: BLACK, borderWidth: 0.8 });

	for (const s of doc.sections) section(s);
	if (doc.info.length) {
		text('Pour information (hors du net à reverser)', { size: 10, font: bold, color: GREY, gap: 16 });
		for (const s of doc.info) section(s);
	}
	return Buffer.from(await pdf.save());
}
