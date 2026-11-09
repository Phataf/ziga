/**
 * Opérations reçues des appareils (lot 05, étape 3) : clé d'idempotence et résultat. Lues et écrites par le seul
 * module sync (règle ESLint d'import) ; pas exportée par l'index du schéma.
 */
import { pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const syncOperations = pgTable(
	'sync_operations',
	{
		organizationId: uuid('organization_id').notNull(),
		idempotencyKey: text('idempotency_key').notNull(),
		userId: uuid('user_id').notNull(),
		operation: text('operation', { enum: ['PUT', 'PATCH', 'DELETE'] }).notNull(),
		tableName: text('table_name').notNull(),
		rowId: text('row_id').notNull(),
		status: text('status', { enum: ['applied', 'rejected'] }).notNull(),
		code: text('code'),
		message: text('message'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [primaryKey({ columns: [t.organizationId, t.idempotencyKey] })]
);
