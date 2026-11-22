/**
 * Lot 10 ter : la migration 0022 s'applique sur une base du lot 10 bis déjà remplie (CLAUDE.md §7). Base jetable migrée
 * jusqu'à 0021, avec un propriétaire, un locataire au numéro d'une personne inscrite, un bail en vigueur, un code SMS de
 * changement de numéro en cours et des lignes d'audit. Après migration : tout est intact (aucune fiche liée, aucun lien
 * créé, colonnes user_id toujours vides) ; la liaison s'enregistre ; un signalement aussi ; migrations rejouées sans
 * doublon, signalements publiés, liens jamais publiés.
 */
import { rmSync } from 'node:fs';
import { newId } from '@ziga/shared/ids';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/migrate.js';
import { insertLease } from './leases.js';
import { foldersUpTo, inOrganization, scratchUrl, serverUrl, withClient } from './migrations.js';
import { propertyWithUnit } from './properties.js';

const SCRATCH = 'ziga_lot10bis_for_0022_test';
const scratch = () => scratchUrl(SCRATCH);

describe('migration 0022 sur une base du lot 10 bis', () => {
	const agency = newId();
	const director = newId();
	const person = newId();
	const ownerId = newId();
	const tenantId = newId();
	const otp = newId();
	const PERSON_PHONE = '+22670555221';
	let lease: string;

	beforeAll(async () => {
		await withClient(serverUrl(), async (c) => {
			await c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
			await c.query(`CREATE DATABASE ${SCRATCH}`);
		});
		const folder = foldersUpTo('0021_inspection_photos_report');
		await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: folder }));
		rmSync(folder, { recursive: true, force: true });
		await withClient(scratch(), async (c) => {
			await c.query(
				`insert into users (id, phone, name, password_hash, status, phone_verified_at) values
					($1, '+22670555220', 'Directrice', 'x', 'active', now()), ($2, $3, 'Salif Traoré', 'x', 'active', now())`,
				[director, person, PERSON_PHONE]
			);
			await c.query(
				`insert into otp_codes (id, phone, purpose, code_hash, expires_at, user_id) values ($1, '+22670555229', 'change_phone', '\\x00', now() + interval '10 minutes', $2)`,
				[otp, person]
			);
			await inOrganization(c, agency, () =>
				c.query(
					`insert into organizations (id, type, legal_name, phone, commune, created_by) values ($1, 'agency', 'Agence du lot 10 bis', '+22625300221', 'Ouagadougou', $2)`,
					[agency, director]
				)
			);
			await inOrganization(c, agency, async () => {
				await c.query(
					`insert into organization_members (id, organization_id, user_id, role, status) values ($1, $2, $3, 'director', 'active')`,
					[newId(), agency, director]
				);
				await c.query(
					`insert into owners (id, organization_id, type, name, phone) values ($1, $2, 'person', 'Propriétaire', '+22670555223')`,
					[ownerId, agency]
				);
				const { unit } = await propertyWithUnit(c, agency, ownerId);
				await c.query(`insert into tenants (id, organization_id, full_name, phone) values ($1, $2, 'Salif Traoré', $3)`, [
					tenantId,
					agency,
					PERSON_PHONE
				]);
				lease = await insertLease(c, agency, unit, tenantId);
				await c.query(
					`insert into audit_log (id, actor_type, actor_user_id, organization_id, action, object_type, object_id, origin)
					 values ($1, 'user', $2, $3, 'tenant.create', 'tenant', $4, 'app')`,
					[newId(), director, agency, tenantId]
				);
			});
		});
		await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: MIGRATIONS_FOLDER }));
	}, 120_000);
	afterAll(async () => {
		await withClient(serverUrl(), (c) => c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`));
	});

	it('les données du lot 10 bis sont intactes : aucune fiche liée, aucun lien, codes et journal inchangés', async () => {
		await withClient(scratch(), async (c) => {
			expect((await c.query(`select purpose, user_id, person_link_id from otp_codes where id = $1`, [otp])).rows).toEqual([
				{ purpose: 'change_phone', user_id: person, person_link_id: null }
			]);
			await inOrganization(
				c,
				agency,
				async () => {
					expect((await c.query(`select count(*)::int as n from person_links`)).rows[0].n).toBe(0);
					expect((await c.query(`select user_id from tenants where id = $1`, [tenantId])).rows).toEqual([{ user_id: null }]);
					expect((await c.query(`select user_id from owners where id = $1`, [ownerId])).rows).toEqual([{ user_id: null }]);
					expect((await c.query(`select action, origin from audit_log where organization_id = $1`, [agency])).rows).toEqual([
						{ action: 'tenant.create', origin: 'app' }
					]);
					expect((await c.query(`select status from leases where id = $1`, [lease])).rows[0].status).toBe('active');
				},
				false
			);
		});
	});

	it('la liaison et le signalement s’enregistrent ; une lecture d’espace s’écrit au journal (origine portal)', async () => {
		await withClient(scratch(), (c) =>
			inOrganization(
				c,
				agency,
				async () => {
					const link = newId();
					await c.query(
						`insert into person_links (id, organization_id, user_id, record_type, tenant_id, status, origin, phone, requested_by)
						 values ($1, $2, $3, 'tenant', $4, 'requested', 'organization_invite', $5, $6)`,
						[link, agency, person, tenantId, PERSON_PHONE, director]
					);
					await c.query(
						`update person_links set phone_verified_at = now(), accepted_by = $2, accepted_at = now(), status = 'active' where id = $1`,
						[link, director]
					);
					await c.query(`select set_config('app.user_id', $1, true)`, [person]);
					expect((await c.query(`select tenant_id from my_person_links()`)).rows).toEqual([{ tenant_id: tenantId }]);
					await c.query(
						`insert into audit_log (id, actor_type, actor_user_id, organization_id, subject_user_id, action, object_type, object_id, origin)
						 values ($1, 'user', $2, $3, $2, 'portal.read', 'person_link', $4, 'portal')`,
						[newId(), person, agency, link]
					);
					await c.query(
						`insert into maintenance_requests (id, organization_id, lease_id, reported_by, title, description) values ($1, $2, $3, $4, 'Fuite', 'Robinet qui fuit')`,
						[newId(), agency, lease, person]
					);
				},
				false
			)
		);
	});

	it('les migrations se rejouent sans erreur ni doublon ; signalements publiés, liens jamais', async () => {
		await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: MIGRATIONS_FOLDER }));
		const tables = await withClient(scratch(), (c) =>
			c.query(
				`select tablename from pg_publication_tables where pubname = 'powersync' and tablename in ('maintenance_requests', 'person_links')`
			)
		);
		expect(tables.rows).toEqual([{ tablename: 'maintenance_requests' }]);
	});
});
