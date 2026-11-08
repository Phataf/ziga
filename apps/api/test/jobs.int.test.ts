/** Files BullMQ : l'API ajoute une tâche, le worker (processus distinct) la traite. */
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Queue, QueueEvents } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/env.js';
import { EXAMPLE_QUEUE, type ExampleJobResult } from '../src/jobs/queues.js';
import { bullConnection } from '../src/redis/redis.module.js';
import { WorkerModule } from '../src/worker.module.js';

const config = parseConfig(process.env);
const prefix = 'ziga';
let worker: INestApplicationContext;
let queue: Queue;
let events: QueueEvents;

beforeAll(async () => {
	worker = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), { logger: false });
	await worker.init();
	queue = new Queue(EXAMPLE_QUEUE, { connection: bullConnection(config.REDIS_URL), prefix });
	events = new QueueEvents(EXAMPLE_QUEUE, { connection: bullConnection(config.REDIS_URL), prefix });
	await events.waitUntilReady();
});

afterAll(async () => {
	await queue.obliterate({ force: true });
	await Promise.all([queue.close(), events.close()]);
	await worker.close();
});

describe('worker BullMQ', () => {
	it('traite une tâche ajoutée à la file', async () => {
		const job = await queue.add('exemple', { message: 'bonjour' });
		const result = (await job.waitUntilFinished(events, 10_000)) as ExampleJobResult;
		expect(result).toEqual({ length: 7, processedBy: process.pid });
	});

	it('traite plusieurs tâches en parallèle (WORKER_CONCURRENCY)', async () => {
		const jobs = await Promise.all(Array.from({ length: 5 }, (_, i) => queue.add('exemple', { message: 'x'.repeat(i + 1) })));
		const finished = Promise.all(jobs.map((j) => j.waitUntilFinished(events, 10_000)));
		await expect(finished).resolves.toHaveLength(5);
	});
});
