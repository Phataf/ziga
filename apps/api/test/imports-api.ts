/**
 * Outils des tests de l'import Excel par l'API (lot 11, étape 3) : envoi d'un fichier par l'URL signée, analyse et
 * exécution en tâche de fond (worker du test), attente de l'état, classeurs écrits pour un test.
 */
import type { ImportJobView } from '@ziga/shared/imports';
import { newId } from '@ziga/shared/ids';
import writeXlsxFile from 'write-excel-file/node';
import { expect } from 'vitest';
import type { PresignedUpload } from '../src/storage/storage.js';
import type { FixtureSheet } from './fixtures/imports/registre-fictif.js';
import type { Member } from './orgs.js';

export async function call<T>(m: Member, method: string, path: string, body?: unknown, status = 200): Promise<T> {
	const r = await m.call<T>(method, path, body);
	expect(r.status, `${method} ${path} ${JSON.stringify(r.body)}`).toBe(status);
	return r.body;
}

export async function refusal(
	m: Member,
	method: string,
	path: string,
	body?: unknown
): Promise<{ status: number; code: string; message: string }> {
	const r = await m.call<{ code: string; message: string }>(method, path, body);
	return { status: r.status, code: r.body.code, message: r.body.message };
}

/** 1er du mois en cours (date de bascule proposée par défaut). */
export const firstOfThisMonth = () => `${new Date().toISOString().slice(0, 7)}-01`;

/** Classeur écrit comme par Excel : cellules texte, nombre ou date. */
export async function workbook(sheets: FixtureSheet[]): Promise<Buffer> {
	const cell = (v: unknown) =>
		v === null || v === ''
			? null
			: v instanceof Date
				? { value: v, type: Date, format: 'dd/mm/yyyy' }
				: typeof v === 'number'
					? { value: v, type: Number }
					: { value: String(v), type: String };
	return writeXlsxFile(sheets.map((s) => ({ sheet: s.name, data: [s.headers.map(cell), ...s.rows.map((r) => r.map(cell))] }))).toBuffer();
}

/** Création de l'import, puis envoi du fichier par l'URL signée (le serveur ne lit jamais le fichier dans la requête). */
export async function uploadImport(
	m: Member,
	localUrl: (u: string) => string,
	file: Buffer,
	extra: { fileName?: string; format?: 'xlsx' | 'csv'; switchOn?: string } = {}
): Promise<ImportJobView> {
	const format = extra.format ?? 'xlsx';
	const r = await call<{ job: ImportJobView; upload: PresignedUpload }>(
		m,
		'POST',
		'/imports',
		{
			id: newId(),
			fileName: extra.fileName ?? `registre.${format}`,
			fileFormat: format,
			fileSize: file.length,
			switchOn: extra.switchOn ?? firstOfThisMonth()
		},
		201
	);
	const put = await fetch(localUrl(r.upload.url), {
		method: 'PUT',
		body: file,
		headers: { 'content-type': r.upload.headers['content-type'] }
	});
	expect(put.status).toBe(200);
	return r.job;
}

const SETTLED = new Set(['uploaded', 'analyzed', 'analysis_failed', 'completed', 'failed', 'cancelled']);

/** Attend que la tâche de fond ait fini (analyse, exécution ou annulation) et renvoie l'import. */
export async function settled(m: Member, id: string, until?: (j: ImportJobView) => boolean, timeoutMs = 90_000): Promise<ImportJobView> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const job = await call<ImportJobView>(m, 'GET', `/imports/${id}`);
		if (until ? until(job) : SETTLED.has(job.status)) return job;
		if (Date.now() > deadline) throw new Error(`Import ${id} toujours « ${job.status} » après ${timeoutMs} ms`);
		await new Promise((r) => setTimeout(r, 150));
	}
}

/** Analyse (ou nouvelle analyse avec des choix), jusqu'à la prévisualisation. */
export async function analyze(m: Member, id: string, body: Record<string, unknown> = {}): Promise<ImportJobView> {
	await call(m, 'POST', `/imports/${id}/analyze`, body, 202);
	return settled(m, id, (j) => j.status !== 'analyzing');
}

export async function execute(m: Member, id: string): Promise<ImportJobView> {
	await call(m, 'POST', `/imports/${id}/execute`, {}, 202);
	return settled(m, id, (j) => j.status !== 'running');
}
