/**
 * Lot 12, étape 2 : annonces, photos d'annonce, prospects et projection publique dans la base (migration 0028), en SQL
 * avec le rôle de l'API (app_api, sans BYPASSRLS). Écrit avant la migration (rouge).
 * - Accès croisé A/B sur listings, listing_photos, leads et showcase_listings : lire, modifier, référencer (règle 1) ;
 *   un prospect n'appartient qu'à l'organisation de l'annonce (règle 15).
 * - Annonce : née interne, par la direction ou la gestion ; machine d'états ; cible et référence figées ; 3 photos
 *   prêtes pour publier ; une seule annonce non retirée par unité et par bien à vendre ; retirée, elle ne change plus ;
 *   jamais supprimée.
 * - Photos : prêtes, de la cible (unité ou parties communes pour une location ; le bien et ses unités pour une vente),
 *   15 au plus.
 * - Prospect : né « nouveau », statuts, affecté à un membre actif qui suit les prospects, source et annonce figées,
 *   jamais supprimé.
 * - Projection publique : lisible sans organisation seulement quand elle est visible ; colonnes comparées à une liste
 *   autorisée (Q10) ; aucun accès du back-office.
 * - Adresse publique : mots réservés (même liste que packages/shared), unique, ancienne adresse jamais reprise,
 *   agences seulement ; ce que la vitrine voit d'une organisation (jamais le nom d'un bailleur, son numéro avec son
 *   accord seulement).
 * - Listes fermées : les mêmes que packages/shared.
 */
import { newId } from '@ziga/shared/ids';
import {
	ARCHIVE_REASONS,
	LEAD_SOURCES,
	LEAD_STATUSES,
	LISTING_OPERATIONS,
	LISTING_VISIBILITIES,
	LOCATION_PRECISIONS,
	RESERVED_PUBLIC_SLUGS,
	SUSPENSION_REASONS
} from '@ziga/shared/listings';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './http.js';
import {
	activeUnit,
	choosePhotos,
	insertFormLead,
	insertListing,
	insertReadyPhoto,
	insertShowcaseRow,
	publishedRentListing
} from './listings.js';
import { addMember, apiSql, createOrg, inContext, sqlError, type Member, type Org } from './orgs.js';
import { insertOwnerRecord, migrationClient, seedIn } from './portals.js';

let t: TestApp;
let owner: pg.Client;
let api: pg.Client;
let admin: pg.Client;
let a: Org;
let b: Org;
let landlord: Org;
let managerA: Member;
let viewerA: Member;
let agentA: Member;
let ownerA: string;
let ownerB: string;
let worldB: { listing: string; property: string; unit: string; photos: string[] };
let leadB: string;
/** Annonce interne de B, sans ligne publique. */
let draftB: string;

const ctxA = () => ({ organizationId: a.id, userId: a.director.userId });

/** Liste autorisée des colonnes de la projection publique (Q10) : une nouvelle colonne s'ajoute ici exprès. */
const SHOWCASE_COLUMNS = [
	'listing_id',
	'organization_id',
	'organization_type',
	'reference',
	'path_segment',
	'operation',
	'title',
	'description',
	'price',
	'commune_id',
	'neighborhood_id',
	'point_lat',
	'point_lng',
	'point_precision',
	'unit_type',
	'property_type',
	'bedrooms',
	'living_rooms',
	'bathrooms',
	'surface_m2',
	'land_area_m2',
	'furnished',
	'amenities',
	'charges',
	'deposit_amount',
	'advance_months',
	'available_from',
	'sale_occupied',
	'declared_land_documents',
	'photos',
	'og_image_key',
	'published_at',
	'visible',
	'updated_at'
];

/** Valeurs de la liste fermée d'une colonne (`colonne = ANY` ou, pour les mots refusés, `colonne <> ALL`). */
async function checkValues(table: string, column: string): Promise<string[]> {
	const r = await owner.query(
		`select pg_get_constraintdef(c.oid) as def from pg_constraint c where c.conrelid = $1::regclass and c.contype = 'c'`,
		[table]
	);
	const list = new RegExp(`\\(${column} (= ANY|<> ALL) \\((ARRAY\\[[^\\]]*\\])`);
	// La liste de la colonne est la plus longue (une autre contrainte peut en citer une partie : `listings_priced`).
	const lists = r.rows
		.map((row) => list.exec(row.def as string))
		.filter((m): m is RegExpExecArray => !!m)
		.map((m) => [...m[2]!.matchAll(/'([^']+)'::text/g)].map((v) => v[1]!))
		.sort((x, y) => y.length - x.length);
	if (!lists.length) throw new Error(`Aucune contrainte de liste pour ${table}.${column}`);
	return lists[0]!;
}

beforeAll(async () => {
	t = await startApp();
	owner = await migrationClient();
	api = await apiSql();
	const pg = await import('pg');
	admin = new pg.default.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
	await admin.connect();
	a = await createOrg(t, 'agency', 'Agence A (annonces)');
	b = await createOrg(t, 'agency', 'Agence B (annonces)');
	landlord = await createOrg(t, 'landlord', 'Salif Compaoré');
	managerA = await addMember(t, a, 'manager');
	viewerA = await addMember(t, a, 'viewer');
	agentA = await addMember(t, a, 'field_agent');
	ownerA = await seedIn(owner, a.id, (c) => insertOwnerRecord(c, a.id, 'Mariam Ouédraogo', '+22670112233'));
	ownerB = await seedIn(owner, b.id, (c) => insertOwnerRecord(c, b.id, 'Issa Kaboré', '+22670445566'));
	worldB = await seedIn(owner, b.id, (c) => publishedRentListing(c, b.id, b.director.userId, ownerB));
	leadB = await seedIn(owner, b.id, async (c) => {
		await insertShowcaseRow(c, b.id, worldB.listing, false);
		return insertFormLead(c, b.id, worldB.listing);
	});
	draftB = await seedIn(owner, b.id, async (c) => insertListing(c, b.id, b.director.userId, { property: worldB.property }));
});

afterAll(async () => {
	await admin?.end();
	await api?.end();
	await owner?.end();
	await t?.close();
});

describe('listes fermées : les mêmes que packages/shared', () => {
	it('annonces, prospects', async () => {
		expect(await checkValues('listings', 'operation')).toEqual([...LISTING_OPERATIONS]);
		expect(await checkValues('listings', 'visibility')).toEqual([...LISTING_VISIBILITIES]);
		expect(await checkValues('listings', 'suspension_reason')).toEqual([...SUSPENSION_REASONS]);
		expect(await checkValues('listings', 'archive_reason')).toEqual([...ARCHIVE_REASONS]);
		expect(await checkValues('listings', 'location_precision')).toEqual([...LOCATION_PRECISIONS]);
		expect(await checkValues('leads', 'source')).toEqual([...LEAD_SOURCES]);
		expect(await checkValues('leads', 'status')).toEqual([...LEAD_STATUSES]);
	});
	it('mots réservés des adresses publiques', async () => {
		expect(await checkValues('organizations', 'public_slug')).toEqual([...RESERVED_PUBLIC_SLUGS]);
	});
});

describe('accès croisé A/B (règles 1 et 15)', () => {
	it('lecture : depuis A, aucune annonce, photo, prospect ni ligne masquée de B', async () => {
		await inContext(api, ctxA(), async () => {
			expect((await api.query(`select 1 from listings where id = $1`, [worldB.listing])).rowCount).toBe(0);
			expect((await api.query(`select 1 from listing_photos where listing_id = $1`, [worldB.listing])).rowCount).toBe(0);
			expect((await api.query(`select 1 from leads where id = $1`, [leadB])).rowCount).toBe(0);
			expect((await api.query(`select 1 from leads where organization_id = $1`, [b.id])).rowCount).toBe(0);
			expect((await api.query(`select 1 from showcase_listings where listing_id = $1`, [worldB.listing])).rowCount).toBe(0);
		});
	});

	it('modification : sans effet sur B', async () => {
		await inContext(api, ctxA(), async () => {
			expect((await api.query(`update listings set title = 'Piraté depuis A' where id = $1`, [worldB.listing])).rowCount).toBe(0);
			expect((await api.query(`update listing_photos set position = 9 where listing_id = $1`, [worldB.listing])).rowCount).toBe(0);
			expect((await api.query(`delete from listing_photos where listing_id = $1`, [worldB.listing])).rowCount).toBe(0);
			expect((await api.query(`update leads set status = 'contacted' where id = $1`, [leadB])).rowCount).toBe(0);
			expect((await api.query(`update showcase_listings set visible = true where listing_id = $1`, [worldB.listing])).rowCount).toBe(0);
			expect((await api.query(`delete from showcase_listings where listing_id = $1`, [worldB.listing])).rowCount).toBe(0);
		});
	});

	it('référence : A ne pointe jamais vers une annonce, une unité, une photo ou un membre de B', async () => {
		await inContext(api, ctxA(), async () => {
			// Annonce de A sur l'unité de B.
			expect(
				(
					await sqlError(
						api,
						`insert into listings (id, organization_id, operation, property_id, unit_id, reference, title, created_by)
						 values ($1, $2, 'rent', $3, $4, 'ZG-AAAAAA', 'Annonce pirate', $5)`,
						[newId(), a.id, worldB.property, worldB.unit, a.director.userId]
					)
				).code
			).toBe('23503');
			// Photo de B dans une annonce de A.
			const { property, unit } = await activeUnit(api, a.id, ownerA);
			const listingA = await insertListing(api, a.id, a.director.userId, { property, unit });
			expect(
				(
					await sqlError(
						api,
						`insert into listing_photos (id, organization_id, listing_id, media_id, position) values ($1, $2, $3, $4, 0)`,
						[newId(), a.id, listingA, worldB.photos[0]]
					)
				).code
			).toMatch(/23503|P0001/);
			// Prospect de A sur l'annonce de B, ou chez B.
			expect(
				(
					await sqlError(
						api,
						`insert into leads (id, organization_id, listing_id, source, name, phone) values ($1, $2, $3, 'form', 'Awa', '+22670000001')`,
						[newId(), a.id, worldB.listing]
					)
				).code
			).toBe('23503');
			expect(
				(
					await sqlError(
						api,
						`insert into leads (id, organization_id, listing_id, source, name, phone) values ($1, $2, $3, 'form', 'Awa', '+22670000001')`,
						[newId(), b.id, worldB.listing]
					)
				).code
			).toBe('42501');
			// Prospect de A affecté à un membre de B.
			const lead = await insertFormLead(api, a.id, listingA);
			expect((await sqlError(api, `update leads set assigned_member_id = $2 where id = $1`, [lead, b.director.userId])).message).toContain(
				'LEAD_ASSIGNEE'
			);
			// Ligne publique de A pour l'annonce de B.
			expect(
				(
					await sqlError(
						api,
						`insert into showcase_listings (listing_id, organization_id, organization_type, reference, path_segment, operation, title, price,
							commune_id, point_lat, point_lng, point_precision, unit_type, property_type, photos, published_at, visible)
						 values ($1, $2, 'agency', 'ZG-HHHHHH', 'zg-hhhhhh', 'rent', 'Copie', 1, 'ouagadougou', 12.3, -1.5, 'commune', 'studio', 'house',
							'[{},{},{}]'::jsonb, now(), true)`,
						[draftB, a.id]
					)
				).code
			).toBe('23503');
		});
	});

	it('le back-office n’a aucun accès à la projection ni aux prospects hors d’un accès d’assistance', async () => {
		await admin.query('BEGIN');
		try {
			expect((await sqlError(admin, `select 1 from showcase_listings limit 1`)).code).toBe('42501');
			expect((await admin.query(`select 1 from leads where id = $1`, [leadB])).rowCount).toBe(0);
		} finally {
			await admin.query('ROLLBACK');
		}
	});
});

describe('annonce : naissance, états, cible (règles 7, 8, D14, D34)', () => {
	it('née interne, par la direction ou la gestion ; jamais par le profil lecture ni l’agent de terrain', async () => {
		await inContext(api, ctxA(), async () => {
			const { property, unit } = await activeUnit(api, a.id, ownerA);
			expect(await insertListing(api, a.id, managerA.userId, { property, unit })).toBeTruthy();
			const second = await activeUnit(api, a.id, ownerA);
			for (const m of [viewerA, agentA]) {
				const e = await sqlError(
					api,
					`insert into listings (id, organization_id, operation, property_id, unit_id, reference, title, created_by)
					 values ($1, $2, 'rent', $3, $4, 'ZG-BBBBBB', 'Annonce interdite', $5)`,
					[newId(), a.id, second.property, second.unit, m.userId]
				);
				expect(e.message).toContain('LISTING_AUTHOR');
			}
			const born = await sqlError(
				api,
				`insert into listings (id, organization_id, operation, property_id, unit_id, reference, title, price, created_by, visibility)
				 values ($1, $2, 'rent', $3, $4, 'ZG-CCCCCC', 'Annonce publiée d’emblée', 1, $5, 'published')`,
				[newId(), a.id, second.property, second.unit, a.director.userId]
			);
			expect(born.message).toMatch(/LISTING_BORN_INTERNAL|listings_published_at/);
		});
	});

	it('location : une unité ; vente : le bien entier', async () => {
		await inContext(api, ctxA(), async () => {
			const { property, unit } = await activeUnit(api, a.id, ownerA);
			const e = await sqlError(
				api,
				`insert into listings (id, organization_id, operation, property_id, unit_id, reference, title, created_by)
				 values ($1, $2, 'sale', $3, $4, 'ZG-DDDDDD', 'Vente d’une unité', $5)`,
				[newId(), a.id, property, unit, a.director.userId]
			);
			expect(e.message).toContain('listings_target');
			expect(await insertListing(api, a.id, a.director.userId, { property })).toBeTruthy();
		});
	});

	it('publication : 3 photos prêtes et un prix ; dates posées par la base', async () => {
		await inContext(api, ctxA(), async () => {
			const { property, unit } = await activeUnit(api, a.id, ownerA);
			const listing = await insertListing(api, a.id, a.director.userId, { property, unit });
			const p1 = await insertReadyPhoto(api, a.id, property, unit);
			const p2 = await insertReadyPhoto(api, a.id, property, unit);
			await choosePhotos(api, a.id, listing, [p1, p2]);
			expect((await sqlError(api, `update listings set visibility = 'pending_review' where id = $1`, [listing])).message).toContain(
				'LISTING_PHOTOS'
			);
		});
		await inContext(api, ctxA(), async () => {
			const { property, unit } = await activeUnit(api, a.id, ownerA);
			const unpriced = await insertListing(api, a.id, a.director.userId, { property, unit }, { price: null });
			const photos = [
				await insertReadyPhoto(api, a.id, property, unit),
				await insertReadyPhoto(api, a.id, property, unit),
				await insertReadyPhoto(api, a.id, property, unit)
			];
			await choosePhotos(api, a.id, unpriced, photos);
			expect((await sqlError(api, `update listings set visibility = 'pending_review' where id = $1`, [unpriced])).message).toContain(
				'listings_priced'
			);
			await api.query(`update listings set price = 75000 where id = $1`, [unpriced]);
			await api.query(`update listings set visibility = 'pending_review' where id = $1`, [unpriced]);
			expect((await sqlError(api, `update listings set published_at = now() where id = $1`, [unpriced])).message).toContain(
				'LISTING_STATE_FIELDS'
			);
			await api.query(`update listings set visibility = 'published' where id = $1`, [unpriced]);
			const r = await api.query(`select published_at, first_published_at, publication_requested_at from listings where id = $1`, [
				unpriced
			]);
			expect(r.rows[0].published_at).toBeInstanceOf(Date);
			expect(r.rows[0].first_published_at).toEqual(r.rows[0].published_at);
			expect(r.rows[0].publication_requested_at).toBeInstanceOf(Date);
		});
	});

	it('machine d’états : suspension avec sa cause, republication par la préparation, retrait définitif', async () => {
		await inContext(api, ctxA(), async () => {
			const { listing } = await publishedRentListing(api, a.id, a.director.userId, ownerA);
			expect((await sqlError(api, `update listings set visibility = 'suspended' where id = $1`, [listing])).message).toContain(
				'listings_suspended'
			);
			await api.query(`update listings set visibility = 'suspended', suspension_reason = 'unit_rented' where id = $1`, [listing]);
			expect((await api.query(`select suspended_at from listings where id = $1`, [listing])).rows[0].suspended_at).toBeInstanceOf(Date);
			expect((await sqlError(api, `update listings set visibility = 'published' where id = $1`, [listing])).message).toContain(
				'LISTING_TRANSITION'
			);
			await api.query(`update listings set visibility = 'pending_review' where id = $1`, [listing]);
			const r = await api.query(`select suspension_reason, suspended_at from listings where id = $1`, [listing]);
			expect(r.rows[0]).toEqual({ suspension_reason: null, suspended_at: null });
			expect((await sqlError(api, `update listings set visibility = 'archived' where id = $1`, [listing])).message).toContain(
				'listings_archived'
			);
			await api.query(`update listings set visibility = 'archived', archive_reason = 'withdrawn' where id = $1`, [listing]);
			expect((await sqlError(api, `update listings set title = 'Encore modifiée' where id = $1`, [listing])).message).toContain(
				'LISTING_ARCHIVED'
			);
			expect((await sqlError(api, `delete from listing_photos where listing_id = $1`, [listing])).message).toContain('LISTING_ARCHIVED');
		});
	});

	it('cible, opération et référence figées ; jamais supprimée', async () => {
		await inContext(api, ctxA(), async () => {
			const { listing } = await publishedRentListing(api, a.id, a.director.userId, ownerA);
			const other = await activeUnit(api, a.id, ownerA);
			expect(
				(await sqlError(api, `update listings set property_id = $2, unit_id = $3 where id = $1`, [listing, other.property, other.unit]))
					.message
			).toContain('LISTING_IMMUTABLE');
			expect((await sqlError(api, `update listings set reference = 'ZG-EEEEEE' where id = $1`, [listing])).message).toContain(
				'LISTING_IMMUTABLE'
			);
			expect((await sqlError(api, `delete from listings where id = $1`, [listing])).code).toBe('42501');
		});
	});

	it('une seule annonce non retirée par unité et par bien à vendre ; après retrait, une nouvelle', async () => {
		await inContext(api, ctxA(), async () => {
			const { property, unit } = await activeUnit(api, a.id, ownerA);
			const first = await insertListing(api, a.id, a.director.userId, { property, unit });
			const dup = await sqlError(
				api,
				`insert into listings (id, organization_id, operation, property_id, unit_id, reference, title, created_by)
				 values ($1, $2, 'rent', $3, $4, 'ZG-FFFFFF', 'Seconde annonce', $5)`,
				[newId(), a.id, property, unit, a.director.userId]
			);
			expect(dup.code).toBe('23505');
			await api.query(`update listings set visibility = 'archived', archive_reason = 'withdrawn' where id = $1`, [first]);
			expect(await insertListing(api, a.id, a.director.userId, { property, unit })).toBeTruthy();
			await insertListing(api, a.id, a.director.userId, { property });
			const dupSale = await sqlError(
				api,
				`insert into listings (id, organization_id, operation, property_id, reference, title, created_by)
				 values ($1, $2, 'sale', $3, 'ZG-GGGGGG', 'Seconde vente', $4)`,
				[newId(), a.id, property, a.director.userId]
			);
			expect(dupSale.code).toBe('23505');
		});
	});
});

describe('photos d’une annonce', () => {
	it('prêtes, de la cible ; 15 au plus ; seul l’ordre change', async () => {
		await inContext(api, ctxA(), async () => {
			const { property, unit } = await activeUnit(api, a.id, ownerA);
			const otherUnit = (
				await api.query(
					`insert into units (id, organization_id, property_id, type, label) values ($1, $2, $3, 'studio', 'Studio B') returning id`,
					[newId(), a.id, property]
				)
			).rows[0].id as string;
			const listing = await insertListing(api, a.id, a.director.userId, { property, unit });
			const ins = (media: string, position: number) =>
				sqlError(api, `insert into listing_photos (id, organization_id, listing_id, media_id, position) values ($1, $2, $3, $4, $5)`, [
					newId(),
					a.id,
					listing,
					media,
					position
				]);
			const pending = newId();
			await api.query(
				`insert into media (id, organization_id, property_id, unit_id, mime_type, byte_size) values ($1, $2, $3, $4, 'image/jpeg', 1000)`,
				[pending, a.id, property, unit]
			);
			expect((await ins(pending, 0)).message).toContain('LISTING_PHOTO_NOT_READY');
			expect((await ins(await insertReadyPhoto(api, a.id, property, otherUnit), 0)).message).toContain('LISTING_PHOTO_TARGET');
			const elsewhere = await activeUnit(api, a.id, ownerA);
			expect((await ins(await insertReadyPhoto(api, a.id, elsewhere.property, null), 0)).message).toContain('LISTING_PHOTO_TARGET');
			expect((await ins(await insertReadyPhoto(api, a.id, property, unit), 15)).message).toContain('listing_photos_position_check');
			const ok = await insertReadyPhoto(api, a.id, property, null);
			await choosePhotos(api, a.id, listing, [ok]);
			const row = (await api.query(`select id from listing_photos where listing_id = $1`, [listing])).rows[0].id as string;
			await api.query(`update listing_photos set position = 4 where id = $1`, [row]);
			expect((await sqlError(api, `update listing_photos set media_id = $2 where id = $1`, [row, pending])).message).toContain(
				'LISTING_PHOTO_IMMUTABLE'
			);
		});
	});

	it('vente : photos du bien et de toutes ses unités', async () => {
		await inContext(api, ctxA(), async () => {
			const { property, unit } = await activeUnit(api, a.id, ownerA);
			const sale = await insertListing(api, a.id, a.director.userId, { property });
			await choosePhotos(api, a.id, sale, [
				await insertReadyPhoto(api, a.id, property, null),
				await insertReadyPhoto(api, a.id, property, unit)
			]);
			expect((await api.query(`select count(*)::int as n from listing_photos where listing_id = $1`, [sale])).rows[0].n).toBe(2);
		});
	});
});

describe('prospects (règle 15)', () => {
	it('formulaire : sans auteur, sur une annonce ; noté à la main : par un membre qui suit les prospects', async () => {
		await inContext(api, ctxA(), async () => {
			const { listing } = await publishedRentListing(api, a.id, a.director.userId, ownerA);
			expect(await insertFormLead(api, a.id, listing)).toBeTruthy();
			const manual = (by: string, source = 'call', listingId: string | null = null) =>
				sqlError(
					api,
					`insert into leads (id, organization_id, listing_id, source, name, phone, created_by) values ($1, $2, $3, $4, 'Issa', '+22676000000', $5)`,
					[newId(), a.id, listingId, source, by]
				);
			expect((await manual(viewerA.userId)).message).toContain('LEAD_AUTHOR');
			expect(
				(
					await sqlError(
						api,
						`insert into leads (id, organization_id, source, name, phone) values ($1, $2, 'form', 'Awa', '+22670000002')`,
						[newId(), a.id]
					)
				).message
			).toMatch(/leads_form_listing/);
			expect((await manual(agentA.userId, 'form', listing)).message).toContain('leads_form');
			await api.query(
				`insert into leads (id, organization_id, source, name, phone, created_by) values ($1, $2, 'whatsapp', 'Issa', '+22676000000', $3)`,
				[newId(), a.id, agentA.userId]
			);
		});
	});

	it('statuts, affectation, champs figés ; jamais supprimé', async () => {
		await inContext(api, ctxA(), async () => {
			const { listing } = await publishedRentListing(api, a.id, a.director.userId, ownerA);
			const lead = await insertFormLead(api, a.id, listing);
			expect(
				(
					await sqlError(
						api,
						`insert into leads (id, organization_id, listing_id, source, name, phone, status) values ($1, $2, $3, 'form', 'Awa', '+22670000003', 'contacted')`,
						[newId(), a.id, listing]
					)
				).message
			).toContain('LEAD_BORN_NEW');
			await api.query(`update leads set status = 'contacted' where id = $1`, [lead]);
			expect((await sqlError(api, `update leads set status = 'new' where id = $1`, [lead])).message).toContain('LEAD_TRANSITION');
			await api.query(`update leads set status = 'converted' where id = $1`, [lead]);
			await api.query(`update leads set status = 'contacted' where id = $1`, [lead]);
			await api.query(`update leads set assigned_member_id = $2 where id = $1`, [lead, agentA.userId]);
			expect((await sqlError(api, `update leads set assigned_member_id = $2 where id = $1`, [lead, viewerA.userId])).message).toContain(
				'LEAD_ASSIGNEE'
			);
			expect((await sqlError(api, `update leads set source = 'call' where id = $1`, [lead])).message).toContain('LEAD_IMMUTABLE');
			expect((await sqlError(api, `update leads set listing_id = null where id = $1`, [lead])).message).toContain('LEAD_IMMUTABLE');
			expect((await sqlError(api, `delete from leads where id = $1`, [lead])).code).toBe('42501');
		});
	});
});

describe('projection publique (Q10)', () => {
	it('colonnes : exactement la liste autorisée', async () => {
		const r = await owner.query(
			`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'showcase_listings' order by ordinal_position`
		);
		expect(r.rows.map((x) => x.column_name)).toEqual(SHOWCASE_COLUMNS);
	});

	it('sans organisation : seulement les lignes visibles, de toutes les organisations ; jamais écrite', async () => {
		const visibleA = await seedIn(owner, a.id, async (c) => {
			const { listing } = await publishedRentListing(c, a.id, a.director.userId, ownerA);
			await insertShowcaseRow(c, a.id, listing, true);
			return listing;
		});
		await inContext(api, {}, async () => {
			const rows = (await api.query(`select listing_id from showcase_listings`)).rows.map((r) => r.listing_id);
			expect(rows).toContain(visibleA);
			expect(rows).not.toContain(worldB.listing);
			expect((await api.query(`update showcase_listings set price = 1 where listing_id = $1`, [visibleA])).rowCount).toBe(0);
			expect((await api.query(`delete from showcase_listings where listing_id = $1`, [visibleA])).rowCount).toBe(0);
			expect((await sqlError(api, `insert into showcase_listings (listing_id) values ($1)`, [newId()])).code).toMatch(/42501|23502/);
		});
		await inContext(api, ctxA(), async () => {
			// Dans le contexte de A, la ligne masquée de B reste invisible ; celle de A se modifie.
			expect((await api.query(`select 1 from showcase_listings where listing_id = $1`, [worldB.listing])).rowCount).toBe(0);
			expect((await api.query(`update showcase_listings set visible = false where listing_id = $1`, [visibleA])).rowCount).toBe(1);
		});
	});

	it('jamais synchronisée', async () => {
		const r = await owner.query(
			`select 1 from pg_publication_tables where pubname = 'powersync' and tablename in ('showcase_listings', 'organization_public_slugs')`
		);
		expect(r.rowCount).toBe(0);
	});
});

describe('adresse publique et ce que la vitrine voit d’une organisation (Q4, Q9)', () => {
	it('mot réservé, format, unicité ; ancienne adresse jamais reprise ; agences seulement', async () => {
		await inContext(api, ctxA(), async () => {
			expect((await sqlError(api, `update organizations set public_slug = 'annonce' where id = $1`, [a.id])).message).toContain(
				'organizations_public_slug_check'
			);
			expect((await sqlError(api, `update organizations set public_slug = 'Agence A' where id = $1`, [a.id])).message).toContain(
				'organizations_public_slug_check'
			);
			expect(
				(await sqlError(api, `insert into organization_public_slugs (slug, organization_id) values ('pirate', $1)`, [a.id])).code
			).toBe('42501');
			// Le rôle de l'API change l'adresse de sa propre organisation ; la base en garde l'historique.
			await api.query(`update organizations set public_slug = 'agence-a-essai' where id = $1`, [a.id]);
			expect((await api.query(`select organization_id from organization_public_slugs where slug = 'agence-a-essai'`)).rows).toEqual([
				{ organization_id: a.id }
			]);
		});
		await seedIn(owner, a.id, async (c) => {
			await c.query(`update organizations set public_slug = 'agence-a-annonces' where id = $1`, [a.id]);
			await c.query(`update organizations set public_slug = 'agence-a-nouvelle' where id = $1`, [a.id]);
		});
		await inContext(api, ctxA(), async () => {
			const history = await api.query(`select slug from organization_public_slugs where organization_id = $1 order by slug`, [a.id]);
			expect(history.rows.map((r) => r.slug)).toEqual(['agence-a-annonces', 'agence-a-nouvelle']);
		});
		await inContext(api, { organizationId: b.id, userId: b.director.userId }, async () => {
			expect((await sqlError(api, `update organizations set public_slug = 'agence-a-annonces' where id = $1`, [b.id])).message).toContain(
				'PUBLIC_SLUG_TAKEN'
			);
			expect((await sqlError(api, `update organizations set public_slug = 'agence-a-nouvelle' where id = $1`, [b.id])).message).toContain(
				'PUBLIC_SLUG_TAKEN'
			);
		});
		await inContext(api, { organizationId: landlord.id, userId: landlord.director.userId }, async () => {
			expect((await sqlError(api, `update organizations set public_slug = 'salif' where id = $1`, [landlord.id])).message).toContain(
				'PUBLIC_SLUG_AGENCY_ONLY'
			);
		});
	});

	it('showcase_organizations : nom et page d’une agence ; jamais le nom d’un bailleur, son numéro avec son accord seulement', async () => {
		await inContext(api, {}, async () => {
			const rows = async () =>
				(await api.query(`select * from showcase_organizations($1::uuid[]) order by type`, [[a.id, landlord.id]])).rows as Record<
					string,
					unknown
				>[];
			const [agency, self] = await rows();
			expect(agency).toMatchObject({
				id: a.id,
				type: 'agency',
				display_name: 'Agence A (annonces)',
				phone: '+22625300000',
				verified: false
			});
			expect(self).toMatchObject({ id: landlord.id, type: 'landlord', display_name: null, public_slug: null, phone: null, logo_id: null });
			expect(Object.keys(agency!).sort()).toEqual(
				['display_name', 'id', 'logo_id', 'phone', 'public_presentation', 'public_slug', 'suspended', 'type', 'verified'].sort()
			);
		});
		await seedIn(owner, landlord.id, (c) => c.query(`update organizations set public_phone_visible = true where id = $1`, [landlord.id]));
		await inContext(api, {}, async () => {
			const r = await api.query(`select phone, display_name from showcase_organizations($1::uuid[])`, [[landlord.id]]);
			expect(r.rows[0]).toEqual({ phone: '+22625300000', display_name: null });
		});
	});

	it('showcase_organization_by_slug : adresse actuelle ou ancienne, vers l’actuelle', async () => {
		await inContext(api, {}, async () => {
			const old = await api.query(`select id, public_slug from showcase_organization_by_slug('agence-a-annonces')`);
			expect(old.rows).toEqual([{ id: a.id, public_slug: 'agence-a-nouvelle' }]);
			expect((await api.query(`select 1 from showcase_organization_by_slug('inconnue')`)).rowCount).toBe(0);
		});
	});

	it('organisation suspendue : signalée à la vitrine', async () => {
		await inContext(api, {}, async () => {
			const r = await api.query(`select suspended from showcase_organizations($1::uuid[])`, [[b.id]]);
			expect(r.rows[0].suspended).toBe(false);
		});
	});
});
