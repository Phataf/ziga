import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalStorage } from './local-storage.js';
import { assertSafeKey } from './storage.js';

describe('stockage local', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ziga-storage-'));
	const storage = new LocalStorage(dir);
	afterAll(() => rm(dir, { recursive: true, force: true }));

	it('écrit, relit et supprime un objet', async () => {
		await storage.check();
		await storage.put('org/a/fichier.txt', Buffer.from('bonjour'), 'text/plain');
		expect((await storage.get('org/a/fichier.txt')).toString()).toBe('bonjour');
		await storage.delete('org/a/fichier.txt');
		await expect(storage.get('org/a/fichier.txt')).rejects.toThrow();
	});

	it('refuse les clés qui sortent du dossier', () => {
		for (const key of ['../secret', '/etc/passwd', 'a/../../b', 'a//b', '']) expect(() => assertSafeKey(key)).toThrow();
	});
});
