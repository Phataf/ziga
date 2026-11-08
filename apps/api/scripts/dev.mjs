// Développement : compile en continu, puis relance l'API (HTTP) et le worker (BullMQ) à chaque changement.
// Deux processus distincts, comme en production.
// Les outils sont lancés directement avec Node (process.execPath), sans passer par `pnpm` : sous Windows,
// `pnpm` est un fichier .cmd que spawn() ne sait pas lancer sans shell.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const node = process.execPath;
const nest = require.resolve('@nestjs/cli/bin/nest.js');
const tsc = require.resolve('typescript/bin/tsc');
const env = ['--env-file-if-exists=../../.env'];

const first = spawnSync(node, [nest, 'build'], { stdio: 'inherit' });
if (first.status !== 0) {
	console.error(`Compilation de l'API impossible (code ${first.status ?? first.error?.message}).`);
	process.exit(first.status ?? 1);
}

const children = [
	spawn(node, [tsc, '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'], { stdio: 'inherit' }),
	spawn(node, [...env, '--watch-path=dist', 'dist/main.js'], { stdio: 'inherit' }),
	spawn(node, [...env, '--watch-path=dist', 'dist/worker.js'], { stdio: 'inherit' })
];
const stop = (signal) => children.forEach((c) => c.kill(signal));
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
