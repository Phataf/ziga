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

describe('stockage local : URL signées (même contrat que S3)', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ziga-storage-signed-'));
	const storage = new LocalStorage(dir, 'http://api.test');
	afterAll(() => rm(dir, { recursive: true, force: true }));
	const tokenOf = (url: string) => url.slice('http://api.test/storage/local/'.length);

	it('envoi : le jeton fixe l’opération, la clé, le type et la taille ; il expire', async () => {
		const up = await storage.presignPut('media/a/original', { contentType: 'image/jpeg', contentLength: 10, expiresInSeconds: 600 });
		expect(up).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/jpeg', 'content-length': '10' } });
		const grant = storage.verify(tokenOf(up.url), 'PUT');
		expect(grant).toMatchObject({ key: 'media/a/original', contentType: 'image/jpeg', contentLength: 10 });
		expect(storage.verify(tokenOf(up.url), 'GET')).toBeNull();
		expect(storage.verify(tokenOf(up.url), 'PUT', Date.now() + 601_000)).toBeNull();
	});

	it('un jeton modifié, ou signé par un autre processus, est refusé', async () => {
		const up = await storage.presignPut('media/a/original', { contentType: 'image/jpeg', contentLength: 10, expiresInSeconds: 600 });
		const [payload, signature] = tokenOf(up.url).split('.');
		const forged = Buffer.from(
			JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), contentLength: 99 })
		).toString('base64url');
		expect(storage.verify(`${forged}.${signature}`, 'PUT')).toBeNull();
		const other = new LocalStorage(dir, 'http://api.test');
		expect(other.verify(tokenOf(up.url), 'PUT')).toBeNull();
	});

	it('lecture : taille et type de l’objet ; un objet absent n’a pas de taille', async () => {
		await storage.put('docs/b/x', Buffer.from('%PDF-1.7'), 'application/pdf');
		expect(await storage.stat('docs/b/x')).toEqual({ size: 8, contentType: 'application/pdf' });
		expect(await storage.stat('docs/b/absent')).toBeNull();
		const url = await storage.presignGet('docs/b/x', { expiresInSeconds: 300, fileName: 'Titre foncier é.pdf' });
		expect(storage.verify(tokenOf(url), 'GET')).toMatchObject({ key: 'docs/b/x' });
		expect(storage.verify(tokenOf(url), 'GET')?.disposition).toContain("filename*=UTF-8''Titre%20foncier%20%C3%A9.pdf");
	});
});
