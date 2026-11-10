/**
 * Référentiel géographique (lot 07) : tables de la plateforme, sans organisation ni RLS (migration 0009_geography).
 * Lu par tous (app_api), complété par le back-office seul (app_admin) ; rien n'est supprimé.
 */
import { boolean, doublePrecision, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const communes = pgTable('communes', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	lat: doublePrecision('lat').notNull(),
	lng: doublePrecision('lng').notNull(),
	osmRef: text('osm_ref'),
	verified: boolean('verified').notNull().default(false),
	updatedAt: tstz('updated_at').notNull().defaultNow(),
	updatedBy: uuid('updated_by')
});

export const neighborhoods = pgTable('neighborhoods', {
	id: uuid('id').primaryKey(),
	communeId: text('commune_id').notNull(),
	name: text('name').notNull(),
	lat: doublePrecision('lat'),
	lng: doublePrecision('lng'),
	osmRef: text('osm_ref'),
	verified: boolean('verified').notNull().default(false),
	createdAt: tstz('created_at').notNull().defaultNow(),
	createdBy: uuid('created_by'),
	updatedAt: tstz('updated_at').notNull().defaultNow(),
	updatedBy: uuid('updated_by')
});
