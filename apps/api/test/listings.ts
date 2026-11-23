/**
 * Annonces, photos d'annonce et prospects de test (lot 12), écrits en SQL dans le contexte d'une organisation (client
 * déjà dans sa transaction de contexte).
 */
import { newId } from '@ziga/shared/ids';
import { newListingReference } from '@ziga/shared/listings';
import { base64Url } from '@ziga/shared/payments';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { insertProperty, insertUnit } from './properties.js';

/** Un bien actif (localisé) et une unité active, prête. */
export async function activeUnit(c: pg.Client, organizationId: string, ownerId: string): Promise<{ property: string; unit: string }> {
	const property = await insertProperty(c, organizationId, ownerId, { recordStatus: 'active' });
	const unit = await insertUnit(c, organizationId, property);
	await c.query(
		`update units set record_status = 'active', rent = 75000, charges = 5000, deposit_amount = 150000, advance_months = 3 where id = $1`,
		[unit]
	);
	return { property, unit };
}

/** Une photo prête (variantes WebP produites) du bien, ou de l'unité. */
export async function insertReadyPhoto(c: pg.Client, organizationId: string, propertyId: string, unitId: string | null): Promise<string> {
	const id = newId();
	await c.query(
		`insert into media (id, organization_id, property_id, unit_id, mime_type, byte_size, status, variants_key, width, height, processed_at)
		 values ($1, $2, $3, $4, 'image/jpeg', 350000, 'ready', $5, 1600, 1067, now())`,
		[id, organizationId, propertyId, unitId, base64Url(randomBytes(16))]
	);
	return id;
}

export async function insertListing(
	c: pg.Client,
	organizationId: string,
	createdBy: string,
	target: { property: string; unit?: string | null },
	extra: { price?: number | null; title?: string } = {}
): Promise<string> {
	const id = newId();
	await c.query(
		`insert into listings (id, organization_id, operation, property_id, unit_id, reference, title, price, created_by)
		 values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		[
			id,
			organizationId,
			target.unit ? 'rent' : 'sale',
			target.property,
			target.unit ?? null,
			newListingReference(),
			extra.title ?? 'Appartement de test à Tampouy',
			extra.price === undefined ? 75_000 : extra.price,
			createdBy
		]
	);
	return id;
}

/** Photos choisies pour l'annonce, dans l'ordre. */
export async function choosePhotos(c: pg.Client, organizationId: string, listingId: string, mediaIds: readonly string[]): Promise<void> {
	for (const [position, mediaId] of mediaIds.entries()) {
		await c.query(`insert into listing_photos (id, organization_id, listing_id, media_id, position) values ($1, $2, $3, $4, $5)`, [
			newId(),
			organizationId,
			listingId,
			mediaId,
			position
		]);
	}
}

/** Une annonce de location publiée : unité active, trois photos, demande puis mise en ligne. */
export async function publishedRentListing(
	c: pg.Client,
	organizationId: string,
	createdBy: string,
	ownerId: string
): Promise<{ listing: string; property: string; unit: string; photos: string[] }> {
	const { property, unit } = await activeUnit(c, organizationId, ownerId);
	const photos = [
		await insertReadyPhoto(c, organizationId, property, unit),
		await insertReadyPhoto(c, organizationId, property, unit),
		await insertReadyPhoto(c, organizationId, property, null)
	];
	const listing = await insertListing(c, organizationId, createdBy, { property, unit });
	await choosePhotos(c, organizationId, listing, photos);
	await c.query(`update listings set visibility = 'pending_review' where id = $1`, [listing]);
	await c.query(`update listings set visibility = 'published' where id = $1`, [listing]);
	return { listing, property, unit, photos };
}

/** Ligne publique d'une annonce (le module listings l'écrit à la publication). */
export async function insertShowcaseRow(c: pg.Client, organizationId: string, listingId: string, visible = true): Promise<void> {
	const l = (
		await c.query(
			`select l.reference, l.title, l.price, l.published_at, p.commune_id, p.neighborhood_id, p.type
			 from listings l join properties p on p.organization_id = l.organization_id and p.id = l.property_id where l.id = $1`,
			[listingId]
		)
	).rows[0];
	const photos = JSON.stringify([1, 2, 3].map(() => ({ key: base64Url(randomBytes(16)), width: 1600, height: 1067 })));
	await c.query(
		`insert into showcase_listings (listing_id, organization_id, organization_type, reference, path_segment, operation, title, price,
			commune_id, neighborhood_id, point_lat, point_lng, point_precision, unit_type, property_type, bedrooms, furnished, charges,
			deposit_amount, advance_months, photos, published_at, visible)
		 values ($1, $2, 'agency', $3, $4, 'rent', $5, $6, $7, $8, 12.37, -1.53, 'neighborhood', 'apartment', $9, 2, false, 5000, 150000, 3,
			$10::jsonb, coalesce($11, now()), $12)`,
		[
			listingId,
			organizationId,
			l.reference,
			`appartement-${String(l.reference).toLowerCase()}`,
			l.title,
			l.price,
			l.commune_id,
			l.neighborhood_id,
			l.type,
			photos,
			l.published_at,
			visible
		]
	);
}

export async function insertFormLead(c: pg.Client, organizationId: string, listingId: string, phone = '+22670998877'): Promise<string> {
	const id = newId();
	await c.query(
		`insert into leads (id, organization_id, listing_id, source, name, phone, message) values ($1, $2, $3, 'form', 'Awa Ouédraogo', $4, 'Je souhaite visiter.')`,
		[id, organizationId, listingId, phone]
	);
	return id;
}
