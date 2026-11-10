/**
 * URL signées du stockage local (développement et tests) : même contrat que S3. Un envoi n'est accepté qu'avec le
 * type et la taille signés, exactement ; une lecture, seulement avant l'expiration. Sans jeton valide : 403, comme S3.
 * Avec le stockage S3, ces routes n'existent pas (404).
 */
import { Controller, Get, HttpCode, Inject, Param, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError } from '../common/app-error.js';
import { Public } from '../modules/identity/auth.guard.js';
import { LocalStorage } from './local-storage.js';
import { STORAGE, type StorageAdapter } from './storage.js';

const refused = () => new AppError('SIGNATURE_INVALID', 'Adresse signée invalide ou expirée.', 403);

@Controller('storage/local')
export class LocalStorageController {
	constructor(@Inject(STORAGE) private readonly storage: StorageAdapter) {}

	private local(): LocalStorage {
		if (!(this.storage instanceof LocalStorage)) throw new AppError('NOT_FOUND', 'Introuvable.', 404);
		return this.storage;
	}

	@Public()
	@Put(':token')
	@HttpCode(200)
	async put(@Param('token') token: string, @Req() req: Request): Promise<void> {
		const storage = this.local();
		const grant = storage.verify(token, 'PUT');
		if (!grant) throw refused();
		const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
		const declared = Number(req.headers['content-length']);
		if (type !== grant.contentType || declared !== grant.contentLength) throw refused();
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req) {
			size += (chunk as Buffer).length;
			if (size > grant.contentLength!) throw refused();
			chunks.push(chunk as Buffer);
		}
		if (size !== grant.contentLength) throw refused();
		await storage.put(grant.key, Buffer.concat(chunks), type);
	}

	@Public()
	@Get(':token')
	async get(@Param('token') token: string, @Res() res: Response): Promise<void> {
		const storage = this.local();
		const grant = storage.verify(token, 'GET');
		if (!grant) throw refused();
		const found = await storage.stat(grant.key);
		if (!found) throw new AppError('NOT_FOUND', 'Introuvable.', 404);
		res.setHeader('Content-Type', grant.contentType ?? found.contentType ?? 'application/octet-stream');
		if (grant.disposition) res.setHeader('Content-Disposition', grant.disposition);
		res.setHeader('Cache-Control', 'private, no-store');
		res.setHeader('X-Content-Type-Options', 'nosniff');
		res.send(await storage.get(grant.key));
	}
}
