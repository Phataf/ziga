/**
 * Lecture d'un fichier envoyé (lot 11), dans la tâche de fond seulement, jamais dans la requête HTTP : un fil à part
 * (`spreadsheet-worker.ts`), limité en mémoire, arrêté au bout de la durée permise. Toutes les limites se règlent par
 * l'environnement (`IMPORT_*`, `.env.example`).
 */
import { Worker } from 'node:worker_threads';
import { IMPORT_MAX_FILE_BYTES } from '@ziga/shared/imports';
import { ImportFileError, type ImportLimits, type ReadSheet } from './spreadsheet-worker.js';

export { ImportFileError, unzipEntries, type ImportLimits, type ReadSheet } from './spreadsheet-worker.js';

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
	maxFileBytes: IMPORT_MAX_FILE_BYTES,
	maxUncompressedBytes: 50 * 1024 * 1024,
	maxSheets: 12,
	maxRows: 5_000,
	maxCells: 250_000,
	timeoutMs: 30_000
};

/** Mémoire du fil de lecture (Mo) : bien au-delà d'un registre réel, bien en deçà de celle du worker. */
const THREAD_HEAP_MB = 512;

// Depuis les sources (tests), le fil se lance sur le fichier TypeScript (types retirés par Node) ; depuis le build, sur le JS.
const threadFile = new URL(import.meta.url.endsWith('.ts') ? './spreadsheet-worker.ts' : './spreadsheet-worker.js', import.meta.url);

export async function readSpreadsheet(
	buffer: Buffer,
	file: { format: 'xlsx' | 'csv'; fileName: string },
	limits: ImportLimits
): Promise<{ sheets: ReadSheet[] }> {
	if (buffer.length > limits.maxFileBytes) {
		throw new ImportFileError(
			'IMPORT_FILE_TOO_LARGE',
			`Fichier trop volumineux : ${Math.max(1, Math.round(limits.maxFileBytes / 1024 / 1024))} Mo au plus.`
		);
	}
	return new Promise((resolve, reject) => {
		const worker = new Worker(threadFile, {
			workerData: { task: 'read-spreadsheet', buffer: new Uint8Array(buffer), format: file.format, fileName: file.fileName, limits },
			resourceLimits: { maxOldGenerationSizeMb: THREAD_HEAP_MB }
		});
		let finished = false;
		const finish = (fn: () => void) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			fn();
			void worker.terminate();
		};
		const timer = setTimeout(
			() =>
				finish(() =>
					reject(new ImportFileError('IMPORT_ANALYSIS_TIMEOUT', 'Analyse du fichier trop longue : découpez-le en plusieurs fichiers.'))
				),
			limits.timeoutMs
		);
		worker.once('message', (m: { sheets?: ReadSheet[]; error?: { code: ImportFileError['code']; message: string } }) =>
			finish(() => (m.error ? reject(new ImportFileError(m.error.code, m.error.message)) : resolve({ sheets: m.sheets! })))
		);
		worker.once('error', (error: Error & { code?: string }) =>
			finish(() =>
				reject(
					error.code === 'ERR_WORKER_OUT_OF_MEMORY'
						? new ImportFileError('IMPORT_UNCOMPRESSED_TOO_LARGE', 'Fichier refusé : trop lourd à lire. Découpez-le en plusieurs fichiers.')
						: error
				)
			)
		);
		worker.once('exit', (code) => finish(() => reject(new Error(`Lecture du fichier interrompue (code ${code}).`))));
	});
}
