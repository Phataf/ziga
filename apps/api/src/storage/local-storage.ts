import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { assertSafeKey, attachment, type PresignedUpload, type StorageAdapter } from './storage.js';

/** Ce que porte une URL signée du stockage local : l'opération, la clé, et pour un envoi le type et la taille exacts. */
export interface LocalGrant {
	method: 'PUT' | 'GET';
	key: string;
	contentType?: string;
	contentLength?: number;
	disposition?: string;
	expiresAt: number;
}

/**
 * Stockage dans un dossier local : développement et tests seulement (refusé en production par la configuration).
 * Il imite les URL signées de S3 (route publique /storage/local/<jeton>) : jeton HMAC qui fixe l'opération, la clé, le
 * type et la taille, et l'expiration. La clé de signature est tirée au démarrage du processus (rien à configurer).
 */
export class LocalStorage implements StorageAdapter {
	readonly driver = 'local' as const;
	private readonly root: string;
	private readonly secret: Buffer;

	constructor(
		dir: string,
		private readonly baseUrl = 'http://localhost:3000',
		secret?: Buffer
	) {
		this.root = resolve(dir);
		this.secret = secret ?? randomBytes(32);
	}

	private path(key: string): string {
		assertSafeKey(key);
		return join(this.root, key);
	}

	async check(): Promise<void> {
		await mkdir(this.root, { recursive: true });
		await access(this.root, constants.R_OK | constants.W_OK);
	}

	async put(key: string, body: Buffer, contentType: string): Promise<void> {
		const path = this.path(key);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, body);
		await writeFile(`${path}.type`, contentType);
	}

	async get(key: string): Promise<Buffer> {
		return readFile(this.path(key));
	}

	async delete(key: string): Promise<void> {
		const path = this.path(key);
		await rm(path, { force: true });
		await rm(`${path}.type`, { force: true });
	}

	async stat(key: string): Promise<{ size: number; contentType: string | null } | null> {
		const path = this.path(key);
		try {
			const s = await stat(path);
			const type = await readFile(`${path}.type`, 'utf8').catch(() => null);
			return { size: s.size, contentType: type };
		} catch {
			return null;
		}
	}

	async presignPut(
		key: string,
		options: { contentType: string; contentLength: number; expiresInSeconds: number }
	): Promise<PresignedUpload> {
		assertSafeKey(key);
		const expiresAt = Date.now() + options.expiresInSeconds * 1000;
		const token = this.sign({ method: 'PUT', key, contentType: options.contentType, contentLength: options.contentLength, expiresAt });
		return {
			url: `${this.baseUrl}/storage/local/${token}`,
			method: 'PUT',
			headers: { 'content-type': options.contentType, 'content-length': String(options.contentLength) },
			expiresAt: new Date(expiresAt).toISOString()
		};
	}

	async presignGet(key: string, options: { expiresInSeconds: number; fileName?: string; contentType?: string }): Promise<string> {
		assertSafeKey(key);
		const token = this.sign({
			method: 'GET',
			key,
			contentType: options.contentType,
			disposition: options.fileName ? attachment(options.fileName) : undefined,
			expiresAt: Date.now() + options.expiresInSeconds * 1000
		});
		return `${this.baseUrl}/storage/local/${token}`;
	}

	private mac(payload: string): Buffer {
		return createHmac('sha256', this.secret).update(payload).digest();
	}

	private sign(grant: LocalGrant): string {
		const payload = Buffer.from(JSON.stringify(grant)).toString('base64url');
		return `${payload}.${this.mac(payload).toString('base64url')}`;
	}

	/** Jeton valide, pour cette opération, non expiré ; sinon null (le stockage refuse, comme S3). */
	verify(token: string, method: LocalGrant['method'], now = Date.now()): LocalGrant | null {
		const [payload, signature, ...rest] = token.split('.');
		if (!payload || !signature || rest.length) return null;
		const expected = this.mac(payload);
		const given = Buffer.from(signature, 'base64url');
		if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
		let grant: LocalGrant;
		try {
			grant = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as LocalGrant;
		} catch {
			return null;
		}
		if (grant.method !== method || !(grant.expiresAt > now)) return null;
		try {
			assertSafeKey(grant.key);
		} catch {
			return null;
		}
		return grant;
	}
}
