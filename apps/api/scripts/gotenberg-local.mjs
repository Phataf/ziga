#!/usr/bin/env node
/**
 * Imitation locale de Gotenberg, pour les sessions SANS Docker (développement en ligne) : même route
 * (POST /forms/libreoffice/convert, champ « files »), même authentification de base, /health, et conversion par le
 * LibreOffice de la machine (`soffice --headless --convert-to pdf`). La CI et la production utilisent la vraie image
 * gotenberg/gotenberg:8.40.0-libreoffice : ce script ne sert qu'à faire tourner les tests ici, comme
 * E2E_POWERSYNC_NODE pour PowerSync (lot 05).
 *
 * Usage : node apps/api/scripts/gotenberg-local.mjs [port]  (lit GOTENBERG_USERNAME et GOTENBERG_PASSWORD)
 * Exige `soffice` et les polices Carlito, Caladea et Liberation sur la machine.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const port = Number(process.argv[2] ?? 3001);
const user = process.env.GOTENBERG_USERNAME;
const password = process.env.GOTENBERG_PASSWORD;
const expected = user && password ? `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` : null;

/** Lit le premier fichier d'un corps multipart/form-data. */
function firstFile(body, contentType) {
	const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
	if (!boundary) return null;
	const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
	let start = body.indexOf(delimiter);
	while (start >= 0) {
		const next = body.indexOf(delimiter, start + delimiter.length);
		if (next < 0) break;
		const part = body.subarray(start + delimiter.length + 2, next - 2);
		const headerEnd = part.indexOf('\r\n\r\n');
		const headers = part.subarray(0, headerEnd).toString('utf8');
		const name = /filename="([^"]+)"/i.exec(headers)?.[1];
		if (name) return { name: name.replace(/[^A-Za-z0-9._-]/g, '_'), data: part.subarray(headerEnd + 4) };
		start = next;
	}
	return null;
}

const server = createServer(async (req, res) => {
	if (expected && req.headers.authorization !== expected) {
		res.writeHead(401).end('Unauthorized');
		return;
	}
	if (req.method === 'GET' && req.url === '/health') {
		res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"up"}');
		return;
	}
	if (req.method !== 'POST' || req.url !== '/forms/libreoffice/convert') {
		res.writeHead(404).end('Not Found');
		return;
	}
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const file = firstFile(Buffer.concat(chunks), req.headers['content-type']);
	if (!file) {
		res.writeHead(400).end('no file');
		return;
	}
	const dir = await mkdtemp(join(tmpdir(), 'gotenberg-local-'));
	try {
		const input = join(dir, file.name.endsWith('.docx') ? file.name : `${file.name}.docx`);
		await writeFile(input, file.data);
		// Profil LibreOffice propre à chaque conversion : pas de verrou partagé entre deux requêtes.
		await run('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'pdf', '--outdir', dir, input], {
			timeout: 120_000
		});
		const pdf = await readFile(input.replace(/\.docx$/, '.pdf'));
		res.writeHead(200, { 'content-type': 'application/pdf' }).end(pdf);
	} catch (error) {
		res.writeHead(500).end(String(error?.message ?? error));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

server.listen(port, '127.0.0.1', () => console.log(`Gotenberg local (LibreOffice) sur http://127.0.0.1:${port}`));
