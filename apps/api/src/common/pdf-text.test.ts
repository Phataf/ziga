/**
 * Règle 2 dans les PDF dessinés par pdf-lib (reçus et relevés, lots 09 et 10) : ses polices standard (encodage
 * WinAnsi) n'ont pas l'espace fine insécable U+202F et pdf-lib la refuse ; ces documents utilisent formatFcfaForPdf
 * (U+00A0), que l'encodage accepte. Les contrats passent par LibreOffice (contracts-render.int.test.ts).
 */
import { formatFcfa, formatFcfaForPdf } from '@ziga/shared/money';
import { formatPhone } from '@ziga/shared/phone';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

describe('montants et téléphones dans un PDF de pdf-lib (polices standard)', () => {
	it('U+202F refusée par l’encodage WinAnsi ; la forme des documents (U+00A0) passe et s’écrit', async () => {
		const pdf = await PDFDocument.create();
		for (const name of [StandardFonts.Helvetica, StandardFonts.TimesRoman, StandardFonts.HelveticaBold]) {
			const font = await pdf.embedFont(name);
			expect(() => font.encodeText(formatFcfa(75_000)), name).toThrow(/cannot encode/);
			expect(() => font.encodeText(formatFcfaForPdf(1_250_000)), name).not.toThrow();
			expect(() => font.encodeText(formatPhone('+22670123456')), name).not.toThrow();
			pdf.addPage().drawText(`Loyer : ${formatFcfaForPdf(75_000)}`, { font, size: 12, x: 50, y: 700 });
		}
		expect((await pdf.save()).length).toBeGreaterThan(0);
	});
});
