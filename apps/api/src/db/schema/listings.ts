/**
 * Annonces, photos d'annonce, prospects et projection publique de la vitrine (lot 12, module listings). La migration SQL
 * (0028) fait foi : RLS, machine d'états, cible et référence figées, 3 photos prêtes pour publier, une seule annonce
 * non retirée par unité et par bien à vendre, prospects nés « nouveaux », projection lisible par tous quand elle est
 * visible. Lues et écrites par le seul module listings (test d'architecture) ; pas exportées par l'index du schéma.
 */
import type {
	ArchiveReason,
	LeadSource,
	LeadStatus,
	ListingOperation,
	ListingVisibility,
	LocationPrecision,
	SuspensionReason
} from '@ziga/shared/listings';
import { bigint, boolean, date, doublePrecision, integer, jsonb, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const listings = pgTable('listings', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	operation: text('operation').$type<ListingOperation>().notNull(),
	propertyId: uuid('property_id').notNull(),
	unitId: uuid('unit_id'),
	reference: text('reference').notNull(),
	title: text('title').notNull(),
	description: text('description'),
	price: bigint('price', { mode: 'number' }),
	locationPrecision: text('location_precision').$type<LocationPrecision>().notNull().default('neighborhood'),
	visibility: text('visibility').$type<ListingVisibility>().notNull().default('internal'),
	suspensionReason: text('suspension_reason').$type<SuspensionReason>(),
	suspendedAt: tstz('suspended_at'),
	archiveReason: text('archive_reason').$type<ArchiveReason>(),
	archivedAt: tstz('archived_at'),
	publicationRequestedAt: tstz('publication_requested_at'),
	publishedAt: tstz('published_at'),
	firstPublishedAt: tstz('first_published_at'),
	createdBy: uuid('created_by').notNull(),
	updatedBy: uuid('updated_by'),
	createdAt: tstz('created_at').notNull().defaultNow(),
	updatedAt: tstz('updated_at').notNull().defaultNow()
});

export const listingPhotos = pgTable('listing_photos', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	listingId: uuid('listing_id').notNull(),
	mediaId: uuid('media_id').notNull(),
	position: smallint('position').notNull(),
	createdAt: tstz('created_at').notNull().defaultNow()
});

export const leads = pgTable('leads', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	listingId: uuid('listing_id'),
	source: text('source').$type<LeadSource>().notNull(),
	name: text('name').notNull(),
	phone: text('phone').notNull(),
	message: text('message'),
	status: text('status').$type<LeadStatus>().notNull().default('new'),
	assignedMemberId: uuid('assigned_member_id'),
	notes: text('notes'),
	createdBy: uuid('created_by'),
	lastContactAt: tstz('last_contact_at').notNull().defaultNow(),
	createdAt: tstz('created_at').notNull().defaultNow(),
	updatedAt: tstz('updated_at').notNull().defaultNow()
});

/** Photo publiée : clé des variantes WebP et dimensions ; ni légende, ni original. */
export interface ShowcasePhoto {
	key: string;
	width: number;
	height: number;
}

export const showcaseListings = pgTable('showcase_listings', {
	listingId: uuid('listing_id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	organizationType: text('organization_type').$type<'agency' | 'landlord'>().notNull(),
	reference: text('reference').notNull(),
	pathSegment: text('path_segment').notNull(),
	operation: text('operation').$type<ListingOperation>().notNull(),
	title: text('title').notNull(),
	description: text('description'),
	price: bigint('price', { mode: 'number' }).notNull(),
	communeId: text('commune_id').notNull(),
	neighborhoodId: uuid('neighborhood_id'),
	pointLat: doublePrecision('point_lat').notNull(),
	pointLng: doublePrecision('point_lng').notNull(),
	pointPrecision: text('point_precision').$type<'exact' | 'neighborhood' | 'commune'>().notNull(),
	unitType: text('unit_type'),
	propertyType: text('property_type').notNull(),
	bedrooms: smallint('bedrooms'),
	livingRooms: smallint('living_rooms'),
	bathrooms: smallint('bathrooms'),
	surfaceM2: integer('surface_m2'),
	landAreaM2: integer('land_area_m2'),
	furnished: boolean('furnished'),
	amenities: text('amenities').array().notNull().default([]),
	charges: bigint('charges', { mode: 'number' }),
	depositAmount: bigint('deposit_amount', { mode: 'number' }),
	advanceMonths: smallint('advance_months'),
	availableFrom: date('available_from', { mode: 'string' }),
	saleOccupied: boolean('sale_occupied'),
	declaredLandDocuments: text('declared_land_documents').array().notNull().default([]),
	photos: jsonb('photos').$type<ShowcasePhoto[]>().notNull(),
	ogImageKey: text('og_image_key'),
	publishedAt: tstz('published_at').notNull(),
	visible: boolean('visible').notNull(),
	updatedAt: tstz('updated_at').notNull().defaultNow()
});
