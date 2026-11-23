/**
 * Lot 11, étape 2 : la migration 0025 s'applique sur une base du lot 10 ter déjà remplie (CLAUDE.md §7). Base jetable
 * migrée jusqu'à 0024, avec un propriétaire, un bien, une unité, un locataire, un bail en vigueur, une échéance, une
 * caution et des lignes d'audit. Après migration : tout est intact (aucune ligne marquée d'un import, échéances
 * ordinaires, versement sans encaissement toujours refusé hors import) ; un import s'enregistre ; migrations rejouées
 * sans erreur ; import_jobs jamais publiée.
 */
import { rmSync } from 'node:fs';
import { newId } from '@ziga/shared/ids';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/migrate.js';
import { insertDepositAccount, insertDue, insertLease } from './leases.js';
import { foldersUpTo, inOrganization, scratchUrl, serverUrl, withClient } from './migrations.js';
import { propertyWithUnit } from './properties.js';

const SCRATCH = 'ziga_lot10ter_for_0025_test';
const scratch = () => scratchUrl(SCRATCH);
const TAGGED = [
	'owners',
	'mandates',
	'mandate_versions',
	'mandate_scopes',
	'properties',
	'units',
	'tenants',
	'leases',
	'lease_versions',
	'rent_dues',
	'deposit_accounts',
	'deposit_movements',
	'audit_log'
];

describe('migration 0025 sur une base du lot 10 ter', () => {
	const agency = newId();
	const director = newId();
	const ownerId = newId();
	const tenantId = newId();
	let lease: string;
	let account: string;

	beforeAll(async () => {
		await withClient(serverUrl(), async (c) => {
			await c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
			await c.query(`CREATE DATABASE ${SCRATCH}`);
		});
		const folder = foldersUpTo('0024_settlement_first_proposed');
		await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: folder }));
		rmSync(folder, { recursive: true, force: true });
		await withClient(scratch(), async (c) => {
			await c.query(
				`insert into users (id, phone, name, password_hash, status, phone_verified_at) values ($1, '+22670555250', 'Directrice', 'x', 'active', now())`,
				[director]
			);
			await inOrganization(c, agency, () =>
				c.query(
					`insert into organizations (id, type, legal_name, phone, commune, created_by) values ($1, 'agency', 'Agence du lot 10 ter', '+22625300250', 'Ouagadougou', $2)`,
					[agency, director]
				)
			);
			await inOrganization(c, agency, async () => {
				await c.query(
					`insert into organization_members (id, organization_id, user_id, role, status) values ($1, $2, $3, 'director', 'active')`,
					[newId(), agency, director]
				);
				await c.query(
					`insert into owners (id, organization_id, type, name, phone) values ($1, $2, 'person', 'Propriétaire', '+22670555251')`,
					[ownerId, agency]
				);
				const { unit } = await propertyWithUnit(c, agency, ownerId);
				await c.query(`insert into tenants (id, organization_id, full_name, phone) values ($1, $2, 'Awa Traoré', '+22670555252')`, [
					tenantId,
					agency
				]);
				lease = await insertLease(c, agency, unit, tenantId);
				await insertDue(c, agency, lease, '2026-01-01');
				account = await insertDepositAccount(c, agency, lease);
				await c.query(
					`insert into audit_log (id, actor_type, actor_user_id, organization_id, action, object_type, object_id, origin)
					 values ($1, 'user', $2, $3, 'lease.create', 'lease', $4, 'app')`,
					[newId(), director, agency, lease]
				);
			});
		});
		await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: MIGRATIONS_FOLDER }));
	}, 120_000);
	afterAll(async () => {
		await withClient(serverUrl(), (c) => c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`));
	});

	it('les données du lot 10 ter sont intactes : aucune ligne marquée d’un import, échéances ordinaires', async () => {
		await withClient(scratch(), (c) =>
			inOrganization(
				c,
				agency,
				async () => {
					for (const table of TAGGED) {
						const r = await c.query(`select count(*)::int as n from ${table} where import_job_id is not null`);
						expect(r.rows[0].n, table).toBe(0);
					}
					expect((await c.query(`select kind from rent_dues where lease_id = $1`, [lease])).rows).toEqual([{ kind: 'rent' }]);
					expect((await c.query(`select original_ends_on from leases where id = $1`, [lease])).rows).toEqual([{ original_ends_on: null }]);
					expect((await c.query(`select count(*)::int as n from audit_log where organization_id = $1`, [agency])).rows[0].n).toBe(1);
				},
				false
			)
		);
	});

	it('hors import, un versement de caution sans encaissement reste refusé', async () => {
		await withClient(scratch(), async (c) => {
			await expect(
				inOrganization(
					c,
					agency,
					() =>
						c.query(
							`insert into deposit_movements (id, organization_id, account_id, type, amount, occurred_on) values ($1, $2, $3, 'received', 1000, current_date)`,
							[newId(), agency, account]
						),
					false
				)
			).rejects.toThrow(/DEPOSIT_RECEIPT_VIA_PAYMENT/);
		});
	});

	it('un import s’enregistre ; le journal accepte l’origine « import »', async () => {
		await withClient(scratch(), (c) =>
			inOrganization(
				c,
				agency,
				async () => {
					await c.query(
						`insert into import_jobs (id, organization_id, created_by, status, file_name, file_format, file_size, storage_key, switch_on)
						 values ($1, $2, $3, 'uploaded', 'registre.xlsx', 'xlsx', 1000, 'imports/x.xlsx', current_date)`,
						[newId(), agency, director]
					);
					await c.query(
						`insert into audit_log (id, actor_type, actor_user_id, organization_id, action, object_type, object_id, origin)
						 values ($1, 'user', $2, $3, 'import.create', 'import_job', $4, 'import')`,
						[newId(), director, agency, newId()]
					);
				},
				false
			)
		);
	});

	it('les migrations se rejouent sans erreur ; import_jobs jamais publiée', async () => {
		await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: MIGRATIONS_FOLDER }));
		const tables = await withClient(scratch(), (c) =>
			c.query(`select tablename from pg_publication_tables where pubname = 'powersync' and tablename = 'import_jobs'`)
		);
		expect(tables.rows).toEqual([]);
	});
});
