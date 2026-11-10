/**
 * Biens, unités et photos (lot 07). La migration SQL (0010) fait foi : RLS, clés composites, quota de photos,
 * règle 12 par triggers. Lu et écrit par le seul module properties (règle ESLint d'import, CLAUDE.md §4) ; pas exporté
 * par l'index du schéma. L'occupation d'une unité n'est pas une colonne : elle se calcule (packages/shared).
 */
import { bigint, boolean, date, doublePrecision, integer, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { Amenity, DeclaredLandDocument } from '@ziga/shared/properties';

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const properties = pgTable('properties', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	ownerId: uuid('owner_id').notNull(),
	type: text('type', { enum: ['house', 'apartment_building', 'shared_compound', 'commercial', 'land'] }).notNull(),
	operation: text('operation', { enum: ['rent', 'sale', 'both'] }).notNull(),
	name: text('name').notNull(),
	communeId: text('commune_id'),
	neighborhoodId: uuid('neighborhood_id'),
	addressHint: text('address_hint'),
	gpsLat: doublePrecision('gps_lat'),
	gpsLng: doublePrecision('gps_lng'),
	gpsAccuracyM: integer('gps_accuracy_m'),
	declaredLandDocuments: text('declared_land_documents').array().$type<DeclaredLandDocument[]>().notNull(),
	notes: text('notes'),
	recordStatus: text('record_status', { enum: ['draft', 'active', 'archived'] }).notNull(),
	archivedAt: tstz('archived_at'),
	createdBy: uuid('created_by'),
	createdAt: tstz('created_at').notNull().defaultNow(),
	updatedAt: tstz('updated_at').notNull().defaultNow()
});

export const units = pgTable('units', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	propertyId: uuid('property_id').notNull(),
	type: text('type', {
		enum: [
			'room_lounge',
			'single_room',
			'celibatorium',
			'studio',
			'apartment',
			'mini_villa',
			'villa',
			'duplex',
			'shop',
			'office',
			'store',
			'warehouse',
			'other'
		]
	}).notNull(),
	label: text('label').notNull(),
	bedrooms: smallint('bedrooms').notNull(),
	livingRooms: smallint('living_rooms').notNull(),
	kitchens: smallint('kitchens').notNull(),
	bathrooms: smallint('bathrooms').notNull(),
	terraces: smallint('terraces').notNull(),
	laundries: smallint('laundries').notNull(),
	surfaceM2: integer('surface_m2'),
	landAreaM2: integer('land_area_m2'),
	usage: text('usage', { enum: ['residential', 'professional', 'mixed'] }).notNull(),
	furnished: boolean('furnished').notNull(),
	amenities: text('amenities').array().$type<Amenity[]>().notNull(),
	rent: bigint('rent', { mode: 'number' }),
	charges: bigint('charges', { mode: 'number' }),
	depositAmount: bigint('deposit_amount', { mode: 'number' }),
	advanceMonths: smallint('advance_months'),
	assignedAgentId: uuid('assigned_agent_id'),
	recordStatus: text('record_status', { enum: ['draft', 'active', 'archived'] }).notNull(),
	archivedAt: tstz('archived_at'),
	technicalStatus: text('technical_status', { enum: ['ready', 'to_refurbish', 'under_works', 'unavailable'] }).notNull(),
	technicalReason: text('technical_reason'),
	technicalExpectedOn: date('technical_expected_on', { mode: 'string' }),
	createdBy: uuid('created_by'),
	createdAt: tstz('created_at').notNull().defaultNow(),
	updatedAt: tstz('updated_at').notNull().defaultNow()
});
