/**
 * Photos annoncées sur l'appareil (lot 07, étape 3) : la photo prise hors ligne est mise en file d'envoi et sa fiche
 * se synchronise comme les autres ; le fichier part ensuite par l'URL présignée, en ligne. Mêmes permissions et même
 * service que les routes. PATCH : légende, ordre, ou retrait (« removed ») ; le reste est décidé par le serveur.
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { createMediaSchema, updateMediaSchema } from '@ziga/shared/properties';
import type { SyncOperation } from '@ziga/shared/sync';
import { AppError } from '../../common/app-error.js';
import { organizationOfRow, SyncRegistry } from '../sync/sync-registry.js';
import { MediaService } from './media.service.js';

function columns(op: SyncOperation, allowed: readonly string[]): Record<string, unknown> {
	const data = { ...(op.data ?? {}) };
	for (const column of Object.keys(data)) {
		if (!allowed.includes(column))
			throw new AppError('FIELD_NOT_WRITABLE', `Ce champ ne se modifie pas depuis l’appareil : ${column}.`, 400, { column });
	}
	return data;
}

const has = (data: Record<string, unknown>, column: string) => Object.hasOwn(data, column);
const text = (value: unknown): unknown => (value === '' ? null : value);

@Injectable()
export class MediaSyncHandlers implements OnModuleInit {
	constructor(
		private readonly registry: SyncRegistry,
		private readonly media: MediaService
	) {}

	onModuleInit(): void {
		this.registry.register({
			table: 'media',
			operations: ['PUT', 'PATCH'],
			permission: 'photo.upload',
			creation: ['PUT'],
			organizationOf: organizationOfRow,
			apply: async (op) => {
				if (op.op === 'PUT') {
					const data = columns(op, [
						'organization_id',
						'property_id',
						'unit_id',
						'kind',
						'mime_type',
						'byte_size',
						'position',
						'caption',
						'status'
					]);
					if (has(data, 'kind') && data.kind !== 'photo') throw new AppError('VALIDATION_ERROR', 'Seules les photos sont acceptées.', 400);
					if (has(data, 'status') && data.status !== 'pending') {
						throw new AppError('STATUS_NOT_ALLOWED', 'Ce statut ne se choisit pas depuis l’appareil.', 409);
					}
					await this.media.create(
						createMediaSchema.parse({
							id: op.id,
							propertyId: data.property_id,
							unitId: text(data.unit_id),
							mimeType: data.mime_type,
							byteSize: data.byte_size,
							position: data.position ?? 0,
							caption: text(data.caption)
						})
					);
					return;
				}
				const data = columns(op, ['caption', 'position', 'status']);
				const { status, ...rest } = data;
				if (Object.keys(rest).length) {
					await this.media.update(
						op.id,
						updateMediaSchema.parse({
							...(has(rest, 'caption') ? { caption: text(rest.caption) } : {}),
							...(has(rest, 'position') ? { position: rest.position } : {})
						})
					);
				}
				if (status !== undefined) {
					if (status !== 'removed') throw new AppError('STATUS_NOT_ALLOWED', 'Ce statut ne se choisit pas depuis l’appareil.', 409);
					await this.media.remove(op.id);
				}
			}
		});
	}
}
