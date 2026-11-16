/**
 * Lot 08 bis, point 3 du porteur : rendu PDF par le vrai service de conversion (Gotenberg 8.40 en CI ; imitation
 * locale par LibreOffice dans une session sans Docker, apps/api/scripts/gotenberg-local.mjs).
 * - Modèle synthétique de même structure que celui de l'agence pilote (5 pages selon Word) : rempli, il garde ses 5
 *   pages en PDF, et ses polices Microsoft sont remplacées par leurs équivalents de même métrique (Carlito pour
 *   Calibri, Caladea pour Cambria, Liberation pour Times New Roman et Arial), intégrées au PDF.
 * - Modèle par défaut : converti, sans blanc.
 * - Authentification : sans identifiants, le service refuse.
 */
import { EXAMPLE_CONTRACT_DATA, resolveContractFields, blankFields, type ContractData } from '@ziga/shared/contract-fields';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { docxText, fillTemplate } from '../src/modules/leases/contracts/contract-renderer.js';
import { defaultTemplate } from '../src/modules/leases/contracts/default-templates.js';
import { formatFcfa } from '@ziga/shared/money';
import { buildDocx, p } from '../src/modules/leases/contracts/docx-builder.js';
import { createPdfConverter, GotenbergConverter, pdfPageCount } from '../src/modules/leases/contracts/pdf-converter.js';
import { inspectTemplate } from '../src/modules/leases/contracts/template-inspection.js';
import { EXPECTED_PDF_FONTS, pilotLikeTemplate } from './fixtures/pilot-like-template.js';

const converter = createPdfConverter({
	PDF_CONVERTER: 'gotenberg',
	GOTENBERG_URL: process.env.GOTENBERG_URL,
	GOTENBERG_USERNAME: process.env.GOTENBERG_USERNAME,
	GOTENBERG_PASSWORD: process.env.GOTENBERG_PASSWORD,
	GOTENBERG_TIMEOUT_MS: 120_000
});

/** Noms des polices intégrées au PDF, sans le préfixe de sous-ensemble (« BAAAAA+Carlito-Regular » → « Carlito-Regular »). */
async function pdfFonts(pdf: Buffer): Promise<string[]> {
	const doc = await PDFDocument.load(pdf);
	const names = new Set<string>();
	for (const [, object] of doc.context.enumerateIndirectObjects()) {
		if (object instanceof PDFDict && object.get(PDFName.of('Type')) === PDFName.of('Font')) {
			const base = object.get(PDFName.of('BaseFont'));
			if (base instanceof PDFName) names.add(base.decodeText().replace(/^[A-Z]{6}\+/, ''));
		}
	}
	return [...names].sort();
}

/** Les options de l'agence pilote : agence bailleur, deux dépôts, intérêt de retard, préavis réduit, reconduction. */
const pilotData: ContractData = {
	...EXAMPLE_CONTRACT_DATA,
	lease: {
		...EXAMPLE_CONTRACT_DATA.lease,
		penaltyRateBp: 75,
		penaltyGraceDays: 10,
		penaltyBeneficiary: 'organization',
		reducedNoticeMonths: 1,
		reducedNoticeCases: 'premier emploi, mutation, perte d’emploi',
		earlyTerminationIndemnityMonths: 1,
		renewalMode: 'same_duration'
	},
	deposits: { security: { amount: 150_000, months: 2 }, utilities: { amount: 25_000 } }
};

describe('rendu PDF par le service de conversion', () => {
	it('modèle synthétique de l’agence pilote : chaque balise reconnue et remplie, 5 pages comme dans Word, polices de même métrique', async () => {
		const template = pilotLikeTemplate();
		const inspection = inspectTemplate(template, 'lease');
		expect(inspection.unknown).toEqual([]);
		expect(inspection.unmatchedFonts).toEqual([]);
		expect(inspection.pageCount).toBe(5);
		const values = resolveContractFields(pilotData);
		expect(blankFields(inspection.usages, values)).toEqual([]);
		const filled = fillTemplate(template, values);
		expect(docxText(filled)).not.toMatch(/[{}]/);
		const pdf = await converter.convertDocx(filled, 'contrat.docx');
		expect(await pdfPageCount(pdf)).toBe(inspection.pageCount);
		const fonts = await pdfFonts(pdf);
		for (const family of EXPECTED_PDF_FONTS)
			expect(
				fonts.some((f) => f.startsWith(family)),
				`${family} dans ${fonts.join(', ')}`
			).toBe(true);
		// Aucune police Microsoft absente remplacée par une police de métrique différente (DejaVu, par exemple).
		expect(fonts.filter((f) => /^DejaVu/.test(f))).toEqual([]);
	}, 120_000);

	it('modèle de bail par défaut : converti en PDF, sans blanc', async () => {
		const template = defaultTemplate('lease');
		const values = resolveContractFields(EXAMPLE_CONTRACT_DATA);
		expect(blankFields(inspectTemplate(template, 'lease').usages, values)).toEqual([]);
		const pdf = await converter.convertDocx(fillTemplate(template, values), 'contrat.docx');
		expect(await pdfPageCount(pdf)).toBeGreaterThanOrEqual(2);
		expect((await pdfFonts(pdf)).some((f) => f.startsWith('LiberationSerif'))).toBe(true);
	}, 120_000);

	it('règle 2 : espace fine insécable U+202F dans les quatre familles, sans police de secours ni carré vide', async () => {
		// Caladea (Cambria) n'a pas le glyphe U+202F : LibreOffice la traite comme une espace, sans emprunter de police.
		const families: [string, string][] = [
			['Calibri', 'Carlito'],
			['Cambria', 'Caladea'],
			['Times New Roman', 'LiberationSerif'],
			['Arial', 'LiberationSans']
		];
		for (const [font, expected] of families) {
			const docx = buildDocx({ blocks: [p([{ text: `Loyer : ${formatFcfa(1_250_000)}`, font }])], defaultFont: font });
			const pdf = await converter.convertDocx(docx, 'espaces.docx');
			expect(await pdfFonts(pdf), font).toEqual([expect.stringMatching(new RegExp(`^${expected}`))]);
		}
	}, 120_000);

	it('sans identifiants, le service de conversion refuse', async () => {
		const anonymous = new GotenbergConverter({ url: process.env.GOTENBERG_URL!, timeoutMs: 30_000 });
		await expect(anonymous.convertDocx(defaultTemplate('lease'), 'x.docx')).rejects.toMatchObject({ status: 401 });
	}, 60_000);
});
