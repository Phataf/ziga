// Sert le dossier build/ comme un hébergeur statique : fichier s'il existe, sinon index.html (repli SPA).
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const root = join(import.meta.dirname, '..', 'build');
const port = Number(process.env.PORT ?? 4173);
const types = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.webmanifest': 'application/manifest+json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png'
};

createServer((req, res) => {
	const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
	let file = normalize(join(root, path));
	if (!file.startsWith(root)) {
		res.writeHead(403).end();
		return;
	}
	if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
	const ext = extname(file);
	res.writeHead(200, {
		'content-type': types[ext] ?? 'application/octet-stream',
		'cache-control': file.includes('/_app/immutable/') ? 'public, max-age=31536000, immutable' : 'no-cache'
	});
	createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Maquette servie sur http://localhost:${port}`));
