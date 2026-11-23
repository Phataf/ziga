/**
 * Lecture d'un fichier envoyé (lot 11), exécutée dans un fil à part (`worker_threads`) par `spreadsheet-reader.ts` :
 * le fil a sa limite de mémoire et il est arrêté au bout de la durée permise. Ce fichier n'importe que des paquets (pas
 * de module local) : il se lance tel quel depuis les sources (tests) comme depuis le build.
 *
 * Fichier hostile (ajout 1 du porteur) : avant toute lecture du classeur, chaque fichier XML de l'archive est
 * décompressé sous un budget (`maxOutputLength` de node:zlib) : la taille réelle compte, jamais celle que l'archive
 * annonce. Ensuite seulement, read-excel-file lit les valeurs (une formule rend sa valeur en cache, jamais son texte).
 */
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { inflateRawSync } from 'node:zlib';
import { decodeImportText, parseCsv } from '@ziga/shared/import-csv';
import { detectSheetFromHeaders, IMPORT_SHEET_NAMES } from '@ziga/shared/import-template';
import readXlsxFile from 'read-excel-file/node';

export interface ImportLimits {
	maxFileBytes: number;
	maxUncompressedBytes: number;
	maxSheets: number;
	maxRows: number;
	maxCells: number;
	timeoutMs: number;
}

export type ImportFileErrorCode =
	| 'IMPORT_FILE_TOO_LARGE'
	| 'IMPORT_UNCOMPRESSED_TOO_LARGE'
	| 'IMPORT_UNREADABLE'
	| 'IMPORT_TOO_MANY_SHEETS'
	| 'IMPORT_TOO_MANY_ROWS'
	| 'IMPORT_TOO_MANY_CELLS'
	| 'IMPORT_ANALYSIS_TIMEOUT';

export class ImportFileError extends Error {
	readonly code: ImportFileErrorCode;
	constructor(code: ImportFileErrorCode, message: string) {
		super(message);
		this.code = code;
		this.name = 'ImportFileError';
	}
}

export type SheetCell = string | number | boolean | Date | null;
export interface ReadSheet {
	sheet: string;
	data: SheetCell[][];
}

const megabytes = (n: number) => Math.round(n / 1024 / 1024);
const tooLarge = (limits: ImportLimits) =>
	new ImportFileError(
		'IMPORT_UNCOMPRESSED_TOO_LARGE',
		`Fichier refusé : une fois décompressé, il dépasse ${megabytes(limits.maxUncompressedBytes)} Mo. Enregistrez-le de nouveau depuis Excel, sans images.`
	);
export const unreadable = () => new ImportFileError('IMPORT_UNREADABLE', 'Ce fichier n’est pas un classeur Excel (.xlsx) lisible.');

/** Entrées XML d'une archive ZIP, décompressées sous le budget de taille ; les autres fichiers (images) sont ignorés. */
export function unzipEntries(buffer: Buffer, limits: Pick<ImportLimits, 'maxUncompressedBytes'>): Map<string, Buffer> {
	const all = limits as ImportLimits;
	const end = findEndOfDirectory(buffer);
	const count = buffer.readUInt16LE(end + 10);
	const directoryOffset = buffer.readUInt32LE(end + 16);
	if (count > 2_000 || directoryOffset >= buffer.length) throw unreadable();
	const entries = new Map<string, Buffer>();
	let remaining = limits.maxUncompressedBytes;
	let p = directoryOffset;
	for (let i = 0; i < count; i++) {
		if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) throw unreadable();
		const method = buffer.readUInt16LE(p + 10);
		const compressedSize = buffer.readUInt32LE(p + 20);
		const declaredSize = buffer.readUInt32LE(p + 24);
		const nameLength = buffer.readUInt16LE(p + 28);
		const extraLength = buffer.readUInt16LE(p + 30);
		const commentLength = buffer.readUInt16LE(p + 32);
		const localOffset = buffer.readUInt32LE(p + 42);
		const name = buffer.toString('utf8', p + 46, p + 46 + nameLength);
		p += 46 + nameLength + extraLength + commentLength;
		// ZIP64 (tailles sur 64 bits) : jamais nécessaire pour un registre ; refusé comme trop gros.
		if (compressedSize === 0xffffffff || declaredSize === 0xffffffff || localOffset === 0xffffffff) throw tooLarge(all);
		if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;
		if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw unreadable();
		const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
		if (start + compressedSize > buffer.length) throw unreadable();
		const raw = buffer.subarray(start, start + compressedSize);
		let data: Buffer;
		if (method === 0) {
			data = Buffer.from(raw);
		} else if (method === 8) {
			try {
				data = inflateRawSync(raw, { maxOutputLength: Math.max(1, remaining) });
			} catch (error) {
				if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError) throw tooLarge(all);
				throw unreadable();
			}
		} else {
			throw unreadable();
		}
		remaining -= data.length;
		if (remaining < 0) throw tooLarge(all);
		entries.set(name, data);
	}
	return entries;
}

function findEndOfDirectory(buffer: Buffer): number {
	for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
		if (buffer.readUInt32LE(i) === 0x06054b50) return i;
	}
	throw unreadable();
}

function checkSize(sheets: ReadSheet[], limits: ImportLimits): void {
	if (sheets.length > limits.maxSheets) {
		throw new ImportFileError('IMPORT_TOO_MANY_SHEETS', `Le classeur a ${sheets.length} onglets : ${limits.maxSheets} au plus.`);
	}
	let cells = 0;
	for (const s of sheets) {
		if (s.data.length - 1 > limits.maxRows) {
			throw new ImportFileError('IMPORT_TOO_MANY_ROWS', `L’onglet ${s.sheet} dépasse ${limits.maxRows} lignes.`);
		}
		for (const row of s.data) cells += row.length;
	}
	if (cells > limits.maxCells) {
		throw new ImportFileError('IMPORT_TOO_MANY_CELLS', `Le classeur a trop de cellules remplies : ${limits.maxCells} au plus.`);
	}
}

/** Lecture complète, dans le fil : contrôle de l'archive, valeurs, tailles. */
export async function readInThread(buffer: Buffer, format: 'xlsx' | 'csv', fileName: string, limits: ImportLimits): Promise<ReadSheet[]> {
	let sheets: ReadSheet[];
	if (format === 'csv') {
		const rows: SheetCell[][] = parseCsv(decodeImportText(new Uint8Array(buffer))).map((r) => r.map((c) => (c === '' ? null : c)));
		const key = detectSheetFromHeaders(rows[0] ?? [], 'agency');
		sheets = [{ sheet: key ? IMPORT_SHEET_NAMES[key] : fileName.replace(/\.csv$/i, ''), data: rows }];
	} else {
		unzipEntries(buffer, limits);
		try {
			sheets = (await readXlsxFile(buffer)).map((s) => ({ sheet: s.sheet, data: s.data as SheetCell[][] }));
		} catch {
			throw unreadable();
		}
	}
	checkSize(sheets, limits);
	return sheets;
}

interface ThreadInput {
	task: 'read-spreadsheet';
	buffer: Uint8Array;
	format: 'xlsx' | 'csv';
	fileName: string;
	limits: ImportLimits;
}

if (!isMainThread && parentPort && (workerData as ThreadInput | undefined)?.task === 'read-spreadsheet') {
	const input = workerData as ThreadInput;
	const port = parentPort;
	readInThread(Buffer.from(input.buffer), input.format, input.fileName, input.limits).then(
		(sheets) => port.postMessage({ sheets }),
		(error: unknown) =>
			port.postMessage({
				error:
					error instanceof ImportFileError
						? { code: error.code, message: error.message }
						: { code: 'IMPORT_UNREADABLE', message: unreadable().message }
			})
	);
}
