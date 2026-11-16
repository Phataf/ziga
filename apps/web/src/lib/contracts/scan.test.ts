import { crc32, deflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { assembleScanPdf, placeOnPage } from './scan';

/** PNG gris uni de `width` × `height` pixels. */
function png(width: number, height: number): Uint8Array {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 0, 0, 0, 0], 8); // 8 bits, niveaux de gris
	const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width, 200)])));
	return new Uint8Array(
		Buffer.concat([
			Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
			chunk('IHDR', header),
			chunk('IDAT', deflateSync(rows)),
			chunk('IEND', Buffer.alloc(0))
		])
	);
}

async function pdf(pages: number): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	for (let i = 0; i < pages; i++) doc.addPage([300, 400]);
	return doc.save();
}

describe('scan signé assemblé sur l’appareil (lot 08 bis)', () => {
	it('photos et PDF réunis en un seul PDF, dans l’ordre : une photo par page A4, portrait ou paysage', async () => {
		const bytes = await assembleScanPdf([
			{ type: 'image/png', bytes: png(60, 80) },
			{ type: 'application/pdf', bytes: await pdf(2) },
			{ type: 'image/png', bytes: png(80, 60) }
		]);
		const doc = await PDFDocument.load(bytes);
		const sizes = doc.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())]);
		expect(sizes).toEqual([
			[595, 842],
			[300, 400],
			[300, 400],
			[842, 595]
		]);
		expect(doc.getTitle()).toBe('Contrat signé (scan)');
	});

	it('la photo tient dans la page, marges comprises, centrée', () => {
		const at = placeOnPage(1200, 1600);
		expect(at.width).toBeLessThanOrEqual(at.page[0] - 36 + 1e-6);
		expect(at.height).toBeLessThanOrEqual(at.page[1] - 36 + 1e-6);
		expect(at.x).toBeCloseTo((at.page[0] - at.width) / 2);
	});

	it('refus clairs : rien à assembler, fichier illisible, type inconnu', async () => {
		await expect(assembleScanPdf([])).rejects.toMatchObject({ code: 'EMPTY' });
		await expect(assembleScanPdf([{ type: 'image/png', bytes: new Uint8Array([1, 2, 3]) }])).rejects.toMatchObject({ code: 'UNREADABLE' });
		await expect(assembleScanPdf([{ type: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) }])).rejects.toMatchObject({
			code: 'UNREADABLE'
		});
		await expect(assembleScanPdf([{ type: 'image/gif' as never, bytes: png(1, 1) }])).rejects.toMatchObject({ code: 'UNSUPPORTED' });
	});
});
