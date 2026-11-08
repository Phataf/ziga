// Développement : compile en continu, puis relance l'API (HTTP) et le worker (BullMQ) à chaque changement.
// Deux processus distincts, comme en production.
import { spawn, spawnSync } from 'node:child_process';

const env = ['--env-file-if-exists=../../.env'];
const first = spawnSync('pnpm', ['exec', 'nest', 'build'], { stdio: 'inherit' });
if (first.status !== 0) process.exit(first.status ?? 1);

const children = [
	spawn('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'], { stdio: 'inherit' }),
	spawn('node', [...env, '--watch-path=dist', 'dist/main.js'], { stdio: 'inherit' }),
	spawn('node', [...env, '--watch-path=dist', 'dist/worker.js'], { stdio: 'inherit' })
];
const stop = (signal) => children.forEach((c) => c.kill(signal));
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
