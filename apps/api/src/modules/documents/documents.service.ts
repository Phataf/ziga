/**
 * Registre des documents privés (lot 07, D22, règle 11) : service public du module documents.
 *
 * - Toujours privé : jamais servi publiquement, jamais derrière le CDN ; lecture par URL signée de 5 minutes, après
 *   la matrice par type (packages/shared, canReadDocument) et la restriction de l'organisation, qui ne fait que
 *   réduire. Chaque URL de lecture délivrée écrit une ligne d'audit (document.download).
 * - Dépôt en ligne seulement : le serveur décide la clé (documents/<organisation>/<document>) et signe le type et la
 *   taille (10 minutes). À la réception : taille et type réels contrôlés, empreinte SHA-256 calculée, puis la version
 *   entre en vigueur ; la précédente devient « remplacée » (base). Une version n'est jamais écrasée.
 * - Rien n'est supprimé automatiquement (durée de conservation : question ouverte) ; un document se retire, motivé.
 */
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
	canReadDocument,
	DOCUMENT_URL_TTL_SECONDS,
	type CreateDocumentData,
	type DocumentDownload,
	type DocumentRestriction,
	type DocumentView
} from '@ziga/shared/documents';
import { MAX_UPLOAD_BYTES, UPLOAD_URL_TTL_SECONDS } from '@ziga/shared/properties';
import { and, asc, eq } from 'drizzle-orm';
import { AppError } from '../../common/app-error.js';
import { detectFileType, matchesDeclared } from '../../common/file-types.js';
import { RequestContext } from '../../common/request-context.js';
import { documents } from '../../db/schema/documents.js';
import { STORAGE, type PresignedUpload, type StorageAdapter } from '../../storage/storage.js';
import { AuditService } from '../audit/audit.service.js';
import { assertCan } from '../organizations/organization-context.js';
import { OwnersService } from '../owners/owners.service.js';
import { PropertiesService } from '../properties/properties.service.js';

type DocumentRow = typeof documents.$inferSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function documentView(d: DocumentRow): DocumentView {
	return {
		id: d.id,
		type: d.type,
		ownerId: d.ownerId,
		mandateId: d.mandateId,
		propertyId: d.propertyId,
		unitId: d.unitId,
		version: d.version,
		replacesId: d.replacesId,
		fileName: d.fileName,
		mimeType: d.mimeType,
		byteSize: d.byteSize,
		sha256: d.sha256,
		status: d.status,
		restriction: d.restriction,
		error: d.error,
		uploadedBy: d.uploadedBy,
		createdAt: d.createdAt.toISOString(),
		activatedAt: iso(d.activatedAt),
		replacedAt: iso(d.replacedAt),
		withdrawnAt: iso(d.withdrawnAt),
		withdrawalReason: d.withdrawalReason
	};
}

export function documentKey(organizationId: string, documentId: string): string {
	return `documents/${organizationId}/${documentId}`;
}

const NOT_FOUND = () => new AppError('DOCUMENT_NOT_FOUND', 'Document introuvable.', 404);

@Injectable()
export class DocumentsService {
	constructor(
		private readonly audit: AuditService,
		private readonly owners: OwnersService,
		private readonly properties: PropertiesService,
		@Inject(STORAGE) private readonly storage: StorageAdapter
	) {}

	private context() {
		const scope = RequestContext.organization();
		const userId = RequestContext.get()!.userId!;
		return {
			tx: RequestContext.tx(),
			organizationId: scope.organizationId,
			role: scope.role,
			userId,
			actor: { type: 'user' as const, userId, role: scope.role }
		};
	}

	/** Document de l'organisation que ce membre peut lire (matrice, puis restriction) ; sinon introuvable. */
	private async readable(id: string, lock = false): Promise<DocumentRow> {
		const { tx, organizationId, role } = this.context();
		const q = tx
			.select()
			.from(documents)
			.where(and(eq(documents.organizationId, organizationId), eq(documents.id, id)))
			.limit(1);
		const [row] = lock ? await q.for('update') : await q;
		if (!row || !canReadDocument(role, row)) throw NOT_FOUND();
		return row;
	}

	async list(): Promise<DocumentView[]> {
		const { tx, organizationId, role } = this.context();
		const rows = await tx.select().from(documents).where(eq(documents.organizationId, organizationId)).orderBy(asc(documents.id));
		return rows.filter((d) => canReadDocument(role, d)).map(documentView);
	}

	async get(id: string): Promise<DocumentView> {
		return documentView(await this.readable(id));
	}

	/** Objets liés : de l'organisation (la base le garantit aussi par ses clés composites). */
	private async checkSubjects(input: CreateDocumentData): Promise<void> {
		if (input.ownerId) await this.owners.get(input.ownerId);
		if (input.mandateId) await this.owners.versions(input.mandateId);
		if (input.unitId) {
			const unit = await this.properties.getUnit(input.unitId);
			if (unit.propertyId !== input.propertyId) throw new AppError('UNIT_NOT_FOUND', 'Unité introuvable.', 404);
		} else if (input.propertyId) {
			await this.properties.get(input.propertyId);
		}
	}

	/** Dépôt : la fiche naît en attente ; l'URL d'envoi signe le type et la taille annoncés (10 minutes). */
	async create(input: CreateDocumentData): Promise<{ document: DocumentView; upload: PresignedUpload }> {
		const { tx, organizationId, role, userId, actor } = this.context();
		if (input.restriction) assertCan(role, 'document.restrict');
		await this.checkSubjects(input);
		let version = 1;
		if (input.replacesId) {
			const previous = await this.readable(input.replacesId, true);
			if (previous.status !== 'active') {
				throw new AppError('DOCUMENT_NOT_ACTIVE', 'Seule la version en vigueur peut être remplacée.', 409, { status: previous.status });
			}
			const same = (['type', 'ownerId', 'mandateId', 'propertyId', 'unitId'] as const).every((k) => previous[k] === input[k]);
			if (!same) throw new AppError('DOCUMENT_VERSION_SUBJECT', 'Une nouvelle version garde le type et les objets liés.', 400);
			version = previous.version + 1;
		}
		const exists = await tx.select({ id: documents.id }).from(documents).where(eq(documents.id, input.id)).limit(1);
		if (exists.length) throw new AppError('CONFLICT', 'Ce document existe déjà.', 409);
		const storageKey = documentKey(organizationId, input.id);
		const [row] = await tx
			.insert(documents)
			.values({
				id: input.id,
				organizationId,
				type: input.type,
				ownerId: input.ownerId,
				mandateId: input.mandateId,
				propertyId: input.propertyId,
				unitId: input.unitId,
				version,
				replacesId: input.replacesId,
				fileName: input.fileName,
				mimeType: input.mimeType,
				byteSize: input.byteSize,
				storageKey,
				status: 'pending',
				restriction: input.restriction,
				uploadedBy: userId
			})
			.returning();
		await this.audit.record(tx, {
			actor,
			organizationId,
			action: 'document.create',
			objectType: 'document',
			objectId: input.id,
			after: {
				type: input.type,
				ownerId: input.ownerId,
				mandateId: input.mandateId,
				propertyId: input.propertyId,
				unitId: input.unitId,
				version,
				replacesId: input.replacesId,
				fileName: input.fileName,
				byteSize: input.byteSize,
				restriction: input.restriction,
				status: 'pending'
			}
		});
		const upload = await this.storage.presignPut(storageKey, {
			contentType: input.mimeType,
			contentLength: input.byteSize,
			expiresInSeconds: UPLOAD_URL_TTL_SECONDS
		});
		return { document: documentView(row!), upload };
	}

	/** Nouvelle URL d'envoi tant que le fichier n'est pas arrivé (la première a expiré). */
	async uploadUrl(id: string): Promise<PresignedUpload> {
		const row = await this.readable(id);
		if (row.status !== 'pending') throw new AppError('DOCUMENT_NOT_PENDING', 'Ce document a déjà été reçu.', 409, { status: row.status });
		return this.storage.presignPut(row.storageKey, {
			contentType: row.mimeType,
			contentLength: row.byteSize,
			expiresInSeconds: UPLOAD_URL_TTL_SECONDS
		});
	}

	/** Fichier reçu : taille et type réels, empreinte SHA-256 ; la version entre en vigueur ou est refusée. */
	async uploaded(id: string): Promise<DocumentView> {
		const { tx, organizationId, actor } = this.context();
		const row = await this.readable(id, true);
		if (row.status !== 'pending') return documentView(row);
		const found = await this.storage.stat(row.storageKey);
		if (!found) throw new AppError('DOCUMENT_FILE_MISSING', 'Le fichier n’est pas encore arrivé : renvoyez-le.', 409);
		const reject = async (error: string): Promise<DocumentView> => {
			const [rejected] = await tx
				.update(documents)
				.set({ status: 'rejected', error, updatedAt: new Date() })
				.where(and(eq(documents.organizationId, organizationId), eq(documents.id, id)))
				.returning();
			await this.audit.record(tx, {
				actor,
				organizationId,
				action: 'document.reject',
				objectType: 'document',
				objectId: id,
				before: { status: 'pending' },
				after: { status: 'rejected', error }
			});
			RequestContext.afterCommit(() => this.storage.delete(row.storageKey));
			return documentView(rejected!);
		};
		if (found.size > MAX_UPLOAD_BYTES || found.size !== row.byteSize) return reject('FILE_SIZE');
		const body = await this.storage.get(row.storageKey);
		if (body.length !== row.byteSize) return reject('FILE_SIZE');
		if (!matchesDeclared(row.mimeType, detectFileType(body))) return reject('FILE_TYPE');
		const sha256 = createHash('sha256').update(body).digest('hex');
		const now = new Date();
		const [active] = await tx
			.update(documents)
			.set({ status: 'active', sha256, activatedAt: now, updatedAt: now })
			.where(and(eq(documents.organizationId, organizationId), eq(documents.id, id)))
			.returning();
		await this.audit.record(tx, {
			actor,
			organizationId,
			action: 'document.activate',
			objectType: 'document',
			objectId: id,
			before: { status: 'pending' },
			after: { status: 'active', sha256, version: row.version, replacesId: row.replacesId }
		});
		return documentView(active!);
	}

	/** URL de lecture signée de 5 minutes ; chaque URL délivrée est journalisée. */
	async download(id: string): Promise<DocumentDownload> {
		const { tx, organizationId, actor } = this.context();
		const row = await this.readable(id);
		if (row.status === 'pending' || row.status === 'rejected') {
			throw new AppError('DOCUMENT_NOT_AVAILABLE', 'Ce document n’a pas de fichier consultable.', 409, { status: row.status });
		}
		const url = await this.storage.presignGet(row.storageKey, {
			expiresInSeconds: DOCUMENT_URL_TTL_SECONDS,
			fileName: row.fileName,
			contentType: row.mimeType
		});
		await this.audit.record(tx, {
			actor,
			organizationId,
			action: 'document.download',
			objectType: 'document',
			objectId: id,
			after: { version: row.version, sha256: row.sha256, expiresInSeconds: DOCUMENT_URL_TTL_SECONDS }
		});
		return { url, expiresAt: new Date(Date.now() + DOCUMENT_URL_TTL_SECONDS * 1000).toISOString() };
	}

	/** Retrait motivé : la fiche et le fichier restent (rien n'est supprimé), le document n'est plus en vigueur. */
	async withdraw(id: string, reason: string): Promise<DocumentView> {
		const { tx, organizationId, actor, userId } = this.context();
		const row = await this.readable(id, true);
		if (row.status !== 'active' && row.status !== 'replaced') {
			throw new AppError('DOCUMENT_NOT_WITHDRAWABLE', 'Ce document ne peut pas être retiré.', 409, { status: row.status });
		}
		const now = new Date();
		const [updated] = await tx
			.update(documents)
			.set({ status: 'withdrawn', withdrawnAt: now, withdrawnBy: userId, withdrawalReason: reason, updatedAt: now })
			.where(and(eq(documents.organizationId, organizationId), eq(documents.id, id)))
			.returning();
		await this.audit.record(tx, {
			actor,
			organizationId,
			action: 'document.withdraw',
			objectType: 'document',
			objectId: id,
			before: { status: row.status },
			after: { status: 'withdrawn', reason }
		});
		return documentView(updated!);
	}

	/** Restriction à la direction (ou levée) : réservée au directeur ; elle ne fait que réduire la matrice. */
	async restrict(id: string, restriction: DocumentRestriction | null): Promise<DocumentView> {
		const { tx, organizationId, actor } = this.context();
		const row = await this.readable(id, true);
		if (row.restriction === restriction) return documentView(row);
		const [updated] = await tx
			.update(documents)
			.set({ restriction, updatedAt: new Date() })
			.where(and(eq(documents.organizationId, organizationId), eq(documents.id, id)))
			.returning();
		await this.audit.record(tx, {
			actor,
			organizationId,
			action: 'document.restrict',
			objectType: 'document',
			objectId: id,
			before: { restriction: row.restriction },
			after: { restriction }
		});
		return documentView(updated!);
	}
}
