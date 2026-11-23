/**
 * Tâches d'import Excel (lot 11, module imports). La migration SQL (0025) fait foi : RLS, auteur (direction ou gestion),
 * passages d'état, date de bascule, fichier conservé 90 jours, annulation sous 24 heures sans encaissement, jamais de
 * suppression, jamais synchronisée. Lue et écrite par le seul module imports (test d'architecture) ; pas exportée par
 * l'index du schéma.
 */
import { bigint, date, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export type ImportJobStatus = 'uploaded' | 'analyzing' | 'analyzed' | 'analysis_failed' | 'running' | 'completed' | 'failed' | 'cancelled';

export const importJobs = pgTable('import_jobs', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	createdBy: uuid('created_by').notNull(),
	status: text('status').$type<ImportJobStatus>().notNull(),
	fileName: text('file_name').notNull(),
	fileFormat: text('file_format').$type<'xlsx' | 'csv'>().notNull(),
	fileSize: bigint('file_size', { mode: 'number' }).notNull(),
	fileSha256: text('file_sha256'),
	storageKey: text('storage_key').notNull(),
	/** Posé par la base : création + 90 jours (prompt §4). */
	fileExpiresAt: tstz('file_expires_at').notNull(),
	fileDeletedAt: tstz('file_deleted_at'),
	switchOn: date('switch_on', { mode: 'string' }).notNull(),
	mapping: jsonb('mapping').$type<Record<string, unknown>>().notNull(),
	choices: jsonb('choices').$type<Record<string, unknown>>().notNull(),
	preview: jsonb('preview').$type<Record<string, unknown>>(),
	report: jsonb('report').$type<Record<string, unknown>>(),
	error: text('error'),
	startedAt: tstz('started_at'),
	completedAt: tstz('completed_at'),
	cancelledAt: tstz('cancelled_at'),
	cancelledBy: uuid('cancelled_by'),
	cancellationReason: text('cancellation_reason'),
	createdAt: tstz('created_at').notNull().defaultNow(),
	updatedAt: tstz('updated_at').notNull().defaultNow()
});
