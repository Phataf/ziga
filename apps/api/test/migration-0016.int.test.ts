/**
 * Correction du lot 09 : la migration 0016 s'applique sur une base du lot 09 déjà remplie (CLAUDE.md §7). Base jetable
 * migrée jusqu'à 0015, avec un bail en vigueur et un compte de caution versé en partie par un mouvement `received`
 * sans encaissement (saisi au lot 08).
 * Après migration : ce mouvement reste, le compte garde son statut ; un nouveau `received` sans encaissement est refusé
 * au propriétaire du schéma lui-même ; un encaissement complète la caution ; migrations rejouées sans doublon.
 */
import { rmSync } from 'node:fs';
import { newId } from '@ziga/shared/ids';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/migrate.js';
import { foldersUpTo, inOrganization, scratchUrl, serverUrl, withClient } from './migrations.js';
import { allocate, insertPayment } from './payments.js';

const SCRATCH = 'ziga_lot09_for_0016_test';
const scratch = () => scratchUrl(SCRATCH);

describe('migration 0016 sur une base du lot 09', () => {
	const agency = newId();
	const user = newId();
	const lease = newId();
	const account = newId();
	const lot08Movement = newId();

	beforeAll(async () => {
		await withClient(serverUrl(), async (c) => {
			await c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
			await c.query(`CREATE DATABASE ${SCRATCH}`);
		});
		const folder = foldersUpTo('0015_payments');
		await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: folder }));
		rmSync(folder, { recursive: true, force: true });
		await withClient(scratch(), async (c) => {
			await c.query(`insert into users (id, phone, name, password_hash, status) values ($1, '+22670555291', 'Directrice', 'x', 'active')`, [
				user
			]);
			await inOrganization(c, agency, () =>
				c.query(
					`insert into organizations (id, type, legal_name, phone, commune, created_by) values ($1, 'agency', 'Agence du lot 09', '+22625300291', 'Ouagadougou', $2)`,
					[agency, user]
				)
			);
			await inOrganization(c, agency, async () => {
				const ownerId = newId();
				const property = newId();
				const unit = newId();
				const tenant = newId();
				await c.query(
					`insert into owners (id, organization_id, type, name, phone) values ($1, $2, 'person', 'Propriétaire', '+22670555293')`,
					[ownerId, agency]
				);
				await c.query(
					`insert into properties (id, organization_id, owner_id, type, name) values ($1, $2, $3, 'apartment_building', 'Immeuble')`,
					[property, agency, ownerId]
				);
				await c.query(`insert into units (id, organization_id, property_id, type, label) values ($1, $2, $3, 'apartment', 'A1')`, [
					unit,
					agency,
					property
				]);
				await c.query(`insert into tenants (id, organization_id, full_name) values ($1, $2, 'Issa Kaboré')`, [tenant, agency]);
				await c.query(
					`insert into leases (id, organization_id, unit_id, tenant_id, starts_on, ends_on, dues_start_on, rent, charges, rent_effective_from,
						billing_mode, lessor_type, status, activated_on, activated_at)
					 values ($1, $2, $3, $4, '2026-01-01', null, '2026-01-01', 75000, 5000, '2026-01-01', 'calendar_prorata', 'owner', 'active', '2026-01-01', now())`,
					[lease, agency, unit, tenant]
				);
				await c.query(
					`insert into deposit_accounts (id, organization_id, lease_id, type, agreed_amount, holder) values ($1, $2, $3, 'security_deposit', 150000, 'organization')`,
					[account, agency, lease]
				);
				// Avant 0016, la base acceptait encore ce mouvement sans encaissement.
				await c.query(
					`insert into deposit_movements (id, organization_id, account_id, type, amount, occurred_on, created_by) values ($1, $2, $3, 'received', 100000, '2026-01-01', $4)`,
					[lot08Movement, agency, account, user]
				);
			});
		});
		await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: MIGRATIONS_FOLDER }));
	}, 120_000);
	afterAll(async () => {
		await withClient(serverUrl(), (c) => c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`));
	});

	it('le versement du lot 08 sans encaissement reste, le compte garde son statut', async () => {
		await withClient(scratch(), (c) =>
			inOrganization(
				c,
				agency,
				async () => {
					const movements = await c.query(`select id, type, amount::int, payment_id from deposit_movements`);
					expect(movements.rows).toEqual([{ id: lot08Movement, type: 'received', amount: 100_000, payment_id: null }]);
					const status = await c.query(`select status from deposit_accounts where id = $1`, [account]);
					expect(status.rows[0].status).toBe('partially_received');
				},
				false
			)
		);
	});

	it('un nouveau versement sans encaissement est refusé, même au propriétaire du schéma ; un encaissement complète la caution', async () => {
		await withClient(scratch(), (c) =>
			inOrganization(
				c,
				agency,
				async () => {
					await c.query('SAVEPOINT attendu');
					const refused = await c
						.query(
							`insert into deposit_movements (id, organization_id, account_id, type, amount, occurred_on, created_by) values ($1, $2, $3, 'received', 50000, current_date, $4)`,
							[newId(), agency, account, user]
						)
						.then(
							() => null,
							(error: { code: string; message: string }) => error
						);
					await c.query('ROLLBACK TO SAVEPOINT attendu');
					expect(refused).toMatchObject({ code: 'P0001', message: expect.stringContaining('DEPOSIT_RECEIPT_VIA_PAYMENT') });

					const p = await insertPayment(c, agency, lease, {
						purpose: 'deposit',
						depositAccountId: account,
						amount: 50_000,
						confirmedBy: user
					});
					await allocate(c, agency, p, lease, [{ target: 'deposit_account', depositAccountId: account, amount: 50_000 }]);
					await c.query('set constraints all immediate');
					const movements = await c.query(`select type, amount::int, payment_id from deposit_movements order by created_at`);
					expect(movements.rows).toEqual([
						{ type: 'received', amount: 100_000, payment_id: null },
						{ type: 'received', amount: 50_000, payment_id: p }
					]);
					expect((await c.query(`select status from deposit_accounts where id = $1`, [account])).rows[0].status).toBe('held');
				},
				false
			)
		);
	});

	it('les migrations se rejouent sans erreur ni doublon', async () => {
		await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: MIGRATIONS_FOLDER }));
		const triggers = await withClient(scratch(), (c) =>
			c.query(`select count(*)::int as n from pg_trigger where tgname = 'deposit_movements_received_needs_payment'`)
		);
		expect(triggers.rows[0].n).toBe(1);
	});
});
