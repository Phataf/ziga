import { constants } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { assertSafeKey, type StorageAdapter } from './storage.js';

/** Stockage dans un dossier local : développement et tests seulement (refusé en production par la configuration). */
export class LocalStorage implements StorageAdapter {
	readonly driver = 'local' as const;
	private readonly root: string;

	constructor(dir: string) {
		this.root = resolve(dir);
	}

	private path(key: string): string {
		assertSafeKey(key);
		return join(this.root, key);
	}

	async check(): Promise<void> {
		await mkdir(this.root, { recursive: true });
		await access(this.root, constants.R_OK | constants.W_OK);
	}

	async put(key: string, body: Buffer, _contentType: string): Promise<void> {
		const path = this.path(key);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, body);
	}

	async get(key: string): Promise<Buffer> {
		return readFile(this.path(key));
	}

	async delete(key: string): Promise<void> {
		await rm(this.path(key), { force: true });
	}
}
