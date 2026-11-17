/**
 * Lot 09 : la migration 0015 s'applique sur une base du lot 08 bis déjà remplie (CLAUDE.md §7). Base jetable migrée
 * jusqu'à 0014, avec une agence, un bail en vigueur, deux échéances et un compte de caution versé en partie au lot 08
 * (mouvement `received` saisi à la main, sans encaissement).
 * Après migration : échéances et caution inchangées, le mouvement du lot 08 reste (réponse du porteur, point 3) ;
 * réglages des reçus par défaut ; nouvelles tables publiées ; un encaissement complète la caution du lot 08 et son
 * annulation la ramène ; migrations rejouées sans doublon.
 */
import { rmSync } from 'node:fs';
import { newId } from '@ziga/shared/ids';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/migrate.js';
import { foldersUpTo, inOrganization as inAgency, scratchUrl, serverUrl as server, withClient } from './migrations.js';
import { allocate, cancelPayment, insertPayment } from './payments.js';

const SCRATCH = 'ziga_lot08bis_for_0015_test';
const NEW_PUBLISHED = ['payment_allocations', 'payments', 'receipts'];
const scratch = () => scratchUrl(SCRATCH);

describe('migration 0015 sur une base du lot 08 bis', () => {
	const agency = newId();
	const user = newId();
	const lease = newId();
	const account = newId();
	const lot08Movement = newId();

	beforeAll(async () => {
		await withClient(server(), async (c) => {
			await c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
			await c.query(`CREATE DATABASE ${SCRATCH}`);
		});
		const folder = foldersUpTo('0014_contracts');
		await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: folder }));
		rmSync(folder, { recursive: true, force: true });
		await withClient(scratch(), async (c) => {
			await c.query(`insert into users (id, phone, name, password_hash, status) values ($1, '+22670555191', 'Directrice', 'x', 'active')`, [
				user
			]);
			await inAgency(c, agency, () =>
				c.query(
					`insert into organizations (id, type, legal_name, phone, commune, created_by) values ($1, 'agency', 'Agence du lot 08 bis', '+22625300191', 'Ouagadougou', $2)`,
					[agency, user]
				)
			);
			await inAgency(c, agency, async () => {
				const ownerId = newId();
				const property = newId();
				const unit = newId();
				const tenant = newId();
				await c.query(
					`insert into owners (id, organization_id, type, name, phone) values ($1, $2, 'person', 'Propriétaire', '+22670555193')`,
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
				for (const [start, status] of [
					['2026-11-01', 'overdue'],
					['2026-12-01', 'upcoming']
				] as const) {
					await c.query(
						`insert into rent_dues (id, organization_id, lease_id, period_start, period_end, due_on, rent, charges, amount_due, status, lease_version)
						 values ($1, $2, $3, $4, ($4::date + interval '1 month' - interval '1 day')::date, $4::date + 4, 75000, 5000, 80000, $5, 1)`,
						[newId(), agency, lease, start, status]
					);
				}
				await c.query(
					`insert into deposit_accounts (id, organization_id, lease_id, type, agreed_amount, holder) values ($1, $2, $3, 'security_deposit', 150000, 'organization')`,
					[account, agency, lease]
				);
				await c.query(
					`insert into deposit_movements (id, organization_id, account_id, type, amount, occurred_on, created_by) values ($1, $2, $3, 'received', 100000, '2026-01-01', $4)`,
					[lot08Movement, agency, account, user]
				);
			});
		});
	}, 120_000);
	afterAll(async () => {
		await withClient(server(), (c) => c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`));
	});

	it('avant : aucune table d’encaissements', async () => {
		const r = await withClient(scratch(), (c) => c.query(`select to_regclass('payments') as t`));
		expect(r.rows[0].t).toBeNull();
	});

	it('après : échéances, caution et mouvement du lot 08 inchangés ; réglages des reçus par défaut ; tables publiées', async () => {
		await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: MIGRATIONS_FOLDER }));
		await withClient(scratch(), async (c) => {
			await inAgency(
				c,
				agency,
				async () => {
					const dues = await c.query(`select period_start::text, amount_paid::int, status from rent_dues order by period_start`);
					expect(dues.rows).toEqual([
						{ period_start: '2026-11-01', amount_paid: 0, status: 'overdue' },
						{ period_start: '2026-12-01', amount_paid: 0, status: 'upcoming' }
					]);
					const deposit = await c.query(`select status, holder from deposit_accounts where id = $1`, [account]);
					expect(deposit.rows).toEqual([{ status: 'partially_received', holder: 'organization' }]);
					const movements = await c.query(`select id, type, amount::int, payment_id from deposit_movements`);
					expect(movements.rows).toEqual([{ id: lot08Movement, type: 'received', amount: 100_000, payment_id: null }]);
					const org = await c.query(
						`select receipt_prefix, receipt_ticket_width, receipt_numbering_started_at from organizations where id = $1`,
						[agency]
					);
					expect(org.rows).toEqual([{ receipt_prefix: null, receipt_ticket_width: 80, receipt_numbering_started_at: null }]);
				},
				false
			);
			const published = await c.query(`select tablename from pg_publication_tables where pubname = 'powersync' and tablename = any($1)`, [
				[...NEW_PUBLISHED, 'receipt_tokens', 'receipt_counters']
			]);
			expect(published.rows.map((r) => r.tablename).sort()).toEqual(NEW_PUBLISHED);
		});
	});

	it('après : un encaissement complète la caution versée au lot 08 ; son annulation la ramène', async () => {
		await withClient(scratch(), async (c) => {
			await inAgency(
				c,
				agency,
				async () => {
					const p = await insertPayment(c, agency, lease, {
						purpose: 'deposit',
						depositAccountId: account,
						amount: 50_000,
						confirmedBy: user
					});
					await allocate(c, agency, p, lease, [{ target: 'deposit_account', depositAccountId: account, amount: 50_000 }]);
					expect((await c.query(`select status from deposit_accounts where id = $1`, [account])).rows[0].status).toBe('held');
					await cancelPayment(c, agency, p, user);
					await c.query('set constraints all immediate');
					await c.query('set constraints all deferred');
					expect((await c.query(`select status from deposit_accounts where id = $1`, [account])).rows[0].status).toBe('partially_received');
					// L'encaissement de loyer s'impute sur l'échéance en retard du lot 08.
					const due = (await c.query(`select id from rent_dues where period_start = '2026-11-01'`)).rows[0].id;
					const rent = await insertPayment(c, agency, lease, { amount: 80_000, confirmedBy: user });
					await allocate(c, agency, rent, lease, [{ target: 'rent_due', rentDueId: due, amount: 80_000 }]);
					await c.query('set constraints all immediate');
					expect((await c.query(`select amount_paid::int from rent_dues where id = $1`, [due])).rows[0].amount_paid).toBe(80_000);
				},
				false
			);
		});
	});

	it('les migrations se rejouent sans erreur ni doublon sur la base ainsi migrée', async () => {
		await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: MIGRATIONS_FOLDER }));
		const n = await withClient(scratch(), (c) =>
			inAgency(c, agency, async () => (await c.query(`select count(*)::int as n from deposit_movements`)).rows[0].n as number, false)
		);
		expect(n).toBe(1);
	});
});
