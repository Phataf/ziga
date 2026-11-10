/**
 * Registre des documents privés (lot 07, D22). La migration SQL (0010) fait foi : RLS, clés composites, versions
 * figées par trigger. Lu et écrit par le seul module documents (règle ESLint d'import, CLAUDE.md §4) ; pas exporté par
 * l'index du schéma. La clé de stockage ne quitte jamais le serveur.
 */
import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const documents = pgTable('documents', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	type: text('type', {
		enum: ['title_deed', 'puh', 'allocation_certificate', 'apfr', 'owner_identity', 'mandate', 'document_photo', 'other']
	}).notNull(),
	ownerId: uuid('owner_id'),
	mandateId: uuid('mandate_id'),
	propertyId: uuid('property_id'),
	unitId: uuid('unit_id'),
	version: integer('version').notNull(),
	replacesId: uuid('replaces_id'),
	fileName: text('file_name').notNull(),
	mimeType: text('mime_type', {
		enum: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
	}).notNull(),
	byteSize: integer('byte_size').notNull(),
	sha256: text('sha256'),
	storageKey: text('storage_key').notNull(),
	status: text('status', { enum: ['pending', 'active', 'replaced', 'withdrawn', 'rejected'] }).notNull(),
	restriction: text('restriction', { enum: ['director_only'] }),
	error: text('error'),
	uploadedBy: uuid('uploaded_by').notNull(),
	createdAt: tstz('created_at').notNull().defaultNow(),
	activatedAt: tstz('activated_at'),
	replacedAt: tstz('replaced_at'),
	withdrawnAt: tstz('withdrawn_at'),
	withdrawnBy: uuid('withdrawn_by'),
	withdrawalReason: text('withdrawal_reason'),
	updatedAt: tstz('updated_at').notNull().defaultNow()
});
