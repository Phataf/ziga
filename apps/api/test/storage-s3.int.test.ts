/**
 * Lot 07 : URL présignées contre un vrai stockage S3 (SeaweedFS, comme en développement ; voir .github/workflows).
 * Le PUT signé fixe le type et la taille annoncés : le stockage refuse un autre corps. La lecture signée expire.
 * Un objet n'est jamais lisible sans signature.
 */
import { newId } from '@ziga/shared/ids';
import { afterAll, describe, expect, it } from 'vitest';
import { S3Storage } from '../src/storage/s3-storage.js';

const storage = new S3Storage({
	endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:8333',
	region: process.env.S3_REGION ?? 'us-east-1',
	bucket: process.env.S3_BUCKET ?? 'ziga-dev',
	accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
	secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
	forcePathStyle: true,
	timeoutMs: 5000
});
afterAll(() => storage.destroy());

const put = (url: string, body: Buffer, type: string) => fetch(url, { method: 'PUT', body, headers: { 'content-type': type } });

describe('stockage S3 (SeaweedFS) : envoi et lecture signés', () => {
	it('le stockage refuse un corps d’une autre taille ou d’un autre type que ceux signés ; accepte le bon', async () => {
		const key = `tests/${newId()}/original`;
		const up = await storage.presignPut(key, { contentType: 'image/jpeg', contentLength: 10, expiresInSeconds: 600 });
		expect((await put(up.url, Buffer.alloc(11), 'image/jpeg')).status).toBe(403);
		expect((await put(up.url, Buffer.alloc(9), 'image/jpeg')).status).toBe(403);
		expect((await put(up.url, Buffer.alloc(10), 'image/png')).status).toBe(403);
		expect(await storage.stat(key)).toBeNull();
		expect((await put(up.url, Buffer.alloc(10, 1), 'image/jpeg')).status).toBe(200);
		expect(await storage.stat(key)).toEqual({ size: 10, contentType: 'image/jpeg' });
		await storage.delete(key);
	});

	it('lecture : sans signature, refusée ; signée, permise ; expirée, refusée', async () => {
		const key = `tests/${newId()}/doc`;
		await storage.put(key, Buffer.from('%PDF-1.7 test'), 'application/pdf');
		const endpoint = (process.env.S3_ENDPOINT ?? 'http://localhost:8333').replace(/\/$/, '');
		expect((await fetch(`${endpoint}/${process.env.S3_BUCKET ?? 'ziga-dev'}/${key}`)).status).toBe(403);
		const url = await storage.presignGet(key, { expiresInSeconds: 1, fileName: 'titre.pdf' });
		const ok = await fetch(url);
		expect(ok.status).toBe(200);
		expect(ok.headers.get('content-disposition')).toContain('titre.pdf');
		expect(ok.headers.get('cache-control')).toBe('private, no-store');
		await new Promise((r) => setTimeout(r, 2100));
		expect((await fetch(url)).status).toBe(403);
		await storage.delete(key);
	});
});
