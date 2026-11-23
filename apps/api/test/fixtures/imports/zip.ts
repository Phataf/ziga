/**
 * Archives ZIP écrites à la main pour les tests de lecture d'un fichier hostile (lot 11) : une archive qui se décompresse
 * démesurément (« bombe »), ou un classeur minimal écrit en XML (formule avec ou sans valeur en cache).
 * Format ZIP simple (sans ZIP64) : en-têtes locaux, répertoire central, fin de répertoire.
 */
import { deflateRawSync } from 'node:zlib';

export interface ZipEntry {
	name: string;
	/** Contenu à compresser (deflate) ; ou `deflated`, déjà compressé, avec sa taille décompressée annoncée. */
	data?: Buffer;
	deflated?: { data: Buffer; size: number };
}

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(data: Buffer): number {
	let c = 0xffffffff;
	for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

export function zip(entries: ZipEntry[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const e of entries) {
		const name = Buffer.from(e.name, 'utf8');
		const compressed = e.deflated ? e.deflated.data : deflateRawSync(e.data ?? Buffer.alloc(0));
		const size = e.deflated ? e.deflated.size : (e.data ?? Buffer.alloc(0)).length;
		// Le CRC d'une bombe n'est pas calculé (contenu jamais matérialisé) : un lecteur sûr s'arrête avant de le vérifier.
		const crc = e.data ? crc32(e.data) : 0;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0, 6);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(size, 22);
		local.writeUInt16LE(name.length, 26);
		locals.push(local, name, compressed);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(8, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(size, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);
		offset += local.length + name.length + compressed.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

/**
 * `size` octets d'espaces, compressés (un millième environ). `declared` : taille annoncée dans l'archive, qui peut mentir
 * (un lecteur sûr mesure la taille réelle, jamais celle de l'en-tête).
 */
export function deflatedSpaces(size: number, declared = size): { data: Buffer; size: number } {
	return { data: deflateRawSync(Buffer.alloc(size, 0x20), { level: 9 }), size: declared };
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
const WORKBOOK = (name: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;

/** Classeur d'un onglet dont la feuille est donnée en XML (`<sheetData>…</sheetData>`), ou une feuille compressée à part. */
export function minimalXlsx(sheetName: string, sheet: { xml: string } | { deflated: { data: Buffer; size: number } }): Buffer {
	const sheetEntry: ZipEntry =
		'xml' in sheet
			? {
					name: 'xl/worksheets/sheet1.xml',
					data: Buffer.from(
						`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sheet.xml}</worksheet>`
					)
				}
			: { name: 'xl/worksheets/sheet1.xml', deflated: sheet.deflated };
	return zip([
		{ name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES) },
		{ name: '_rels/.rels', data: Buffer.from(ROOT_RELS) },
		{ name: 'xl/workbook.xml', data: Buffer.from(WORKBOOK(sheetName)) },
		{ name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(WORKBOOK_RELS) },
		sheetEntry
	]);
}
