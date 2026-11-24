/**
 * Lot 12, étape 2 : la migration 0028 s'applique sur une base du lot 11 déjà remplie (CLAUDE.md §7). Base jetable
 * migrée jusqu'à 0027, avec une agence, un propriétaire, un bien et une unité actifs, une photo prête et un bail en
 * vigueur. Après migration : tout est intact ; les colonnes publiques de l'organisation sont vides (aucune adresse,
 * aucun accord de numéro) ; une annonce s'enregistre sur l'unité, interne ; annonces, photos et prospects publiés vers
 * PowerSync, jamais la projection publique ; migrations rejouées sans erreur.
 */
import { rmSync } from 'node:fs';
import { newId } from '@ziga/shared/ids';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/migrate.js';
import { insertLease } from './leases.js';
import { activeUnit, insertReadyPhoto } from './listings.js';
import { foldersUpTo, inOrganization, scratchUrl, serverUrl, withClient } from './migrations.js';

const SCRATCH = 'ziga_lot11_for_0028_test';
const scratch = () => scratchUrl(SCRATCH);

describe('migration 0028 sur une base du lot 11', () => {
	const agency = newId();
	const director = newId();
	const ownerId = newId();
	const tenantId = newId();
	let property: string;
	let unit: string;
	let photo: string;
	let lease: string;

	beforeAll(async () => {
		await withClient(serverUrl(), async (c) => {
			await c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
			await c.query(`CREATE DATABASE ${SCRATCH}`);
		});
		const folder = foldersUpTo('0027_property_archive_unlocated');
		await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: folder }));
		rmSync(folder, { recursive: true, force: true });
		await withClient(scratch(), async (c) => {
			await c.query(
				`insert into users (id, phone, name, password_hash, status, phone_verified_at) values ($1, '+22670555280', 'Directrice', 'x', 'active', now())`,
				[director]
			);
			await inOrganization(c, agency, () =>
				c.query(
					`insert into organizations (id, type, legal_name, phone, commune, created_by) values ($1, 'agency', 'Agence du lot 11', '+22625300280', 'Ouagadougou', $2)`,
					[agency, director]
				)
			);
			await inOrganization(c, agency, async () => {
				await c.query(
					`insert into organization_members (id, organization_id, user_id, role, status) values ($1, $2, $3, 'director', 'active')`,
					[newId(), agency, director]
				);
				await c.query(
					`insert into owners (id, organization_id, type, name, phone) values ($1, $2, 'person', 'Propriétaire', '+22670555281')`,
					[ownerId, agency]
				);
				({ property, unit } = await activeUnit(c, agency, ownerId));
				photo = await insertReadyPhoto(c, agency, property, unit);
				await c.query(`insert into tenants (id, organization_id, full_name, phone) values ($1, $2, 'Awa Traoré', '+22670555282')`, [
					tenantId,
					agency
				]);
				lease = await insertLease(c, agency, unit, tenantId);
			});
		});
		await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: MIGRATIONS_FOLDER }));
	}, 120_000);
	afterAll(async () => {
		await withClient(serverUrl(), (c) => c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`));
	});

	it('les données du lot 11 sont intactes ; aucune adresse publique, aucun accord de numéro', async () => {
		await withClient(scratch(), (c) =>
			inOrganization(
				c,
				agency,
				async () => {
					expect((await c.query(`select record_status from units where id = $1`, [unit])).rows).toEqual([{ record_status: 'active' }]);
					expect((await c.query(`select status from media where id = $1`, [photo])).rows).toEqual([{ status: 'ready' }]);
					expect((await c.query(`select count(*)::int as n from leases where id = $1`, [lease])).rows[0].n).toBe(1);
					expect(
						(await c.query(`select public_slug, public_presentation, public_phone_visible from organizations where id = $1`, [agency])).rows
					).toEqual([{ public_slug: null, public_presentation: null, public_phone_visible: false }]);
					expect((await c.query(`select count(*)::int as n from organization_public_slugs`)).rows[0].n).toBe(0);
				},
				false
			)
		);
	});

	it('une annonce s’enregistre sur l’unité, interne ; sa photo se choisit', async () => {
		await withClient(scratch(), (c) =>
			inOrganization(
				c,
				agency,
				async () => {
					const listing = newId();
					await c.query(
						`insert into listings (id, organization_id, operation, property_id, unit_id, reference, title, price, created_by)
						 values ($1, $2, 'rent', $3, $4, 'ZG-7K4M2P', 'Appartement du lot 11', 75000, $5)`,
						[listing, agency, property, unit, director]
					);
					await c.query(`insert into listing_photos (id, organization_id, listing_id, media_id, position) values ($1, $2, $3, $4, 0)`, [
						newId(),
						agency,
						listing,
						photo
					]);
					expect((await c.query(`select visibility from listings where id = $1`, [listing])).rows).toEqual([{ visibility: 'internal' }]);
				},
				false
			)
		);
	});

	it('les migrations se rejouent sans erreur ; annonces, photos et prospects publiés, jamais la projection', async () => {
		await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: MIGRATIONS_FOLDER }));
		const tables = await withClient(scratch(), (c) =>
			c.query(
				`select tablename from pg_publication_tables where pubname = 'powersync'
				 and tablename in ('listings', 'listing_photos', 'leads', 'showcase_listings', 'organization_public_slugs') order by tablename`
			)
		);
		expect(tables.rows.map((r) => r.tablename)).toEqual(['leads', 'listing_photos', 'listings']);
	});
});
