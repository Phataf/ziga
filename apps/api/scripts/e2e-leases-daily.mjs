/**
 * Tests de bout en bout (Playwright) seulement : lance la tâche du jour des baux dans le worker des tests (base Redis
 * n° 2, comme e2e-server.mjs) et attend son résultat, affiché en JSON. La date se passe en argument (`2026-11-21`) ;
 * sans elle, la date du jour. Jamais en production : le worker de production planifie la tâche lui-même.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';

const root = resolve(import.meta.dirname, '../../..');
const file = join(root, '.env');
const base = { ...(existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}), ...process.env };
if (!base.REDIS_URL) throw new Error('Tests de bout en bout : REDIS_URL manquante.');
const url = new URL(base.REDIS_URL);
url.pathname = '/2';
const redis = () => new Redis(url.toString(), { maxRetriesPerRequest: null });

const connections = [redis(), redis()];
const queue = new Queue('leases', { connection: connections[0], prefix: 'ziga' });
const events = new QueueEvents('leases', { connection: connections[1], prefix: 'ziga' });
try {
	await events.waitUntilReady();
	const job = await queue.add('leases-daily', process.argv[2] ? { today: process.argv[2] } : {});
	const result = await job.waitUntilFinished(events, 60_000);
	process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
	await Promise.all([queue.close(), events.close()]);
	for (const c of connections) c.disconnect();
}
