/**
 * Photos (lot 07, étape 3). Routes de l'organisation (@OrganizationScoped, permission par route) et route publique des
 * variantes : seules les variantes WebP traitées sont servies, sous leur clé aléatoire, jamais l'original.
 */
import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Res } from '@nestjs/common';
import { idSchema } from '@ziga/shared/ids';
import { createMediaSchema, MEDIA_VARIANT_SIZES, updateMediaSchema, type MediaVariantSize } from '@ziga/shared/properties';
import type { Response } from 'express';
import { AppError } from '../../common/app-error.js';
import { STORAGE, type StorageAdapter } from '../../storage/storage.js';
import { Creation } from '../features/feature.guards.js';
import { Public } from '../identity/auth.guard.js';
import { Can, OrganizationScoped } from '../organizations/organization-context.js';
import { mediaVariantKey } from './media-processing.js';
import { MediaService } from './media.service.js';

@Controller('media')
@OrganizationScoped()
export class MediaController {
	constructor(private readonly media: MediaService) {}

	@Get(':id')
	@Can('property.read')
	get(@Param('id') id: string) {
		return this.media.get(idSchema.parse(id));
	}

	/** Annonce d'une photo (type, taille) : elle attend son fichier. */
	@Post()
	@Can('photo.upload')
	@Creation()
	@HttpCode(201)
	create(@Body() body: unknown) {
		return this.media.create(createMediaSchema.parse(body));
	}

	/** URL d'envoi présignée (10 minutes), type et taille signés. */
	@Post(':id/upload-url')
	@Can('photo.upload')
	@HttpCode(200)
	uploadUrl(@Param('id') id: string) {
		return this.media.uploadUrl(idSchema.parse(id));
	}

	/** Fichier envoyé : contrôle et variantes par la tâche du worker. */
	@Post(':id/uploaded')
	@Can('photo.upload')
	@HttpCode(200)
	uploaded(@Param('id') id: string) {
		return this.media.uploaded(idSchema.parse(id));
	}

	@Patch(':id')
	@Can('photo.upload')
	update(@Param('id') id: string, @Body() body: unknown) {
		return this.media.update(idSchema.parse(id), updateMediaSchema.parse(body));
	}

	@Post(':id/remove')
	@Can('photo.upload')
	@HttpCode(200)
	remove(@Param('id') id: string) {
		return this.media.remove(idSchema.parse(id));
	}
}

/** Variantes publiques : aucune lecture en base ; la clé aléatoire (128 bits) se lit dans l'adresse. */
@Controller('media/v')
export class PublicMediaController {
	constructor(@Inject(STORAGE) private readonly storage: StorageAdapter) {}

	@Public()
	@Get(':key/:file')
	async file(@Param('key') key: string, @Param('file') file: string, @Res() res: Response) {
		const size = Number(file.replace(/\.webp$/, ''));
		if (!/^[A-Za-z0-9_-]{22,64}$/.test(key) || !file.endsWith('.webp') || !MEDIA_VARIANT_SIZES.includes(size as MediaVariantSize)) {
			throw new AppError('NOT_FOUND', 'Photo introuvable.', 404);
		}
		let body: Buffer;
		try {
			body = await this.storage.get(mediaVariantKey(key, size as MediaVariantSize));
		} catch {
			throw new AppError('NOT_FOUND', 'Photo introuvable.', 404);
		}
		res.setHeader('Content-Type', 'image/webp');
		res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
		res.setHeader('X-Content-Type-Options', 'nosniff');
		res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
		res.send(body);
	}
}
