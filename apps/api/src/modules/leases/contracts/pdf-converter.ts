/**
 * Conversion d'un contrat Word en PDF (lot 08 bis, D23), derrière une interface (CLAUDE.md §4) :
 * - `gotenberg` : le service Gotenberg (image gotenberg/gotenberg:8.40.0-libreoffice), route LibreOffice ; les polices
 *   de même métrique (Carlito pour Calibri, Caladea pour Cambria, Liberation pour Times New Roman et Arial) sont dans
 *   l'image, ce qui garde le nombre de pages et la mise en page ;
 * - `fake` : un PDF d'une page, sans LibreOffice, pour les tests qui ne regardent pas le rendu ; refusé en production.
 */
import { PDFDocument, StandardFonts } from 'pdf-lib';

export interface PdfConverter {
	readonly driver: 'gotenberg' | 'fake';
	/** Convertit un .docx en PDF ; lève une erreur si le service ne répond pas ou refuse le fichier. */
	convertDocx(docx: Buffer, fileName: string): Promise<Buffer>;
	/** Vérifie que le service est joignable (santé). */
	check(): Promise<void>;
}

export const PDF_CONVERTER = Symbol('PDF_CONVERTER');

export class PdfConversionError extends Error {
	constructor(
		message: string,
		readonly status: number | null = null
	) {
		super(message);
		this.name = 'PdfConversionError';
	}
}

export interface GotenbergOptions {
	url: string;
	username?: string;
	password?: string;
	timeoutMs: number;
}

export class GotenbergConverter implements PdfConverter {
	readonly driver = 'gotenberg' as const;

	constructor(private readonly options: GotenbergOptions) {}

	private headers(): Record<string, string> {
		const { username, password } = this.options;
		return username && password ? { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` } : {};
	}

	private endpoint(path: string): string {
		return `${this.options.url.replace(/\/$/, '')}${path}`;
	}

	async convertDocx(docx: Buffer, fileName: string): Promise<Buffer> {
		const form = new FormData();
		const name = fileName.toLowerCase().endsWith('.docx') ? fileName : `${fileName}.docx`;
		form.append(
			'files',
			new Blob([new Uint8Array(docx)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
			name
		);
		let response: Response;
		try {
			response = await fetch(this.endpoint('/forms/libreoffice/convert'), {
				method: 'POST',
				body: form,
				headers: this.headers(),
				signal: AbortSignal.timeout(this.options.timeoutMs)
			});
		} catch (error) {
			throw new PdfConversionError(`Service de conversion injoignable : ${(error as Error).message}`);
		}
		if (!response.ok) {
			const detail = (await response.text().catch(() => '')).slice(0, 300);
			throw new PdfConversionError(`Conversion refusée (${response.status}) : ${detail}`, response.status);
		}
		const pdf = Buffer.from(await response.arrayBuffer());
		if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new PdfConversionError('Le service de conversion n’a pas rendu un PDF.');
		return pdf;
	}

	async check(): Promise<void> {
		const response = await fetch(this.endpoint('/health'), {
			headers: this.headers(),
			signal: AbortSignal.timeout(this.options.timeoutMs)
		});
		if (!response.ok) throw new PdfConversionError(`Service de conversion indisponible (${response.status})`, response.status);
	}
}

/** Un PDF d'une page qui nomme le fichier converti : pour les tests qui ne regardent pas le rendu. */
export class FakePdfConverter implements PdfConverter {
	readonly driver = 'fake' as const;

	async convertDocx(docx: Buffer, fileName: string): Promise<Buffer> {
		const pdf = await PDFDocument.create();
		// Date fixe : un même Word donne le même PDF (empreinte stable dans les tests).
		pdf.setCreationDate(new Date(Date.UTC(2026, 10, 15)));
		pdf.setModificationDate(new Date(Date.UTC(2026, 10, 15)));
		const font = await pdf.embedFont(StandardFonts.Helvetica);
		const page = pdf.addPage();
		page.drawText(`Conversion de test : ${fileName.replace(/[^\x20-\x7e]/g, '?')} (${docx.length} octets)`, {
			x: 50,
			y: 750,
			size: 10,
			font
		});
		return Buffer.from(await pdf.save({ useObjectStreams: false }));
	}

	async check(): Promise<void> {}
}

export function createPdfConverter(config: {
	PDF_CONVERTER: 'gotenberg' | 'fake';
	GOTENBERG_URL?: string;
	GOTENBERG_USERNAME?: string;
	GOTENBERG_PASSWORD?: string;
	GOTENBERG_TIMEOUT_MS: number;
}): PdfConverter {
	if (config.PDF_CONVERTER === 'fake') return new FakePdfConverter();
	return new GotenbergConverter({
		url: config.GOTENBERG_URL!,
		username: config.GOTENBERG_USERNAME,
		password: config.GOTENBERG_PASSWORD,
		timeoutMs: config.GOTENBERG_TIMEOUT_MS
	});
}

/** Nombre de pages d'un PDF (tests du rendu, et version de contrat). */
export async function pdfPageCount(pdf: Buffer): Promise<number> {
	return (await PDFDocument.load(pdf, { updateMetadata: false })).getPageCount();
}
