/**
 * Lot 10 : la migration 0017 s'applique sur une base du lot 09 déjà remplie (CLAUDE.md §7). Base jetable migrée
 * jusqu'à 0016, avec un bail en vigueur, une échéance, un encaissement de loyer confirmé, son imputation et son reçu.
 * Après migration : l'encaissement, son imputation et son reçu sont intacts (objet `rent`, sans dépense) ; l'échéance
 * garde son montant payé ; une dépense, une relance, un relevé émis, son élément, son lien et un reversement
 * s'enregistrent ; l'imputation du lot 09 entre dans un relevé ; migrations rejouées sans doublon.
 */
import { rmSync } from 'node:fs';
import { newId } from '@ziga/shared/ids';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/migrate.js';
import {
	insertExpense,
	insertLine,
	insertPayout,
	insertReminder,
	insertStatement,
	insertStatementToken,
	issueStatement
} from './collections.js';
import { foldersUpTo, inOrganization, scratchUrl, serverUrl, withClient } from './migrations.js';

const SCRATCH = 'ziga_lot09_for_0017_test';
const scratch = () => scratchUrl(SCRATCH);

describe('migration 0017 sur une base du lot 09', () => {
	const agency = newId();
	const user = newId();
	const ownerId = newId();
	const property = newId();
	const unit = newId();
	const tenant = newId();
	const lease = newId();
	const due = newId();
	const payment = newId();
	const allocation = newId();
	const receipt = newId();

	beforeAll(async () => {
		await withClient(serverUrl(), async (c) => {
			await c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
			await c.query(`CREATE DATABASE ${SCRATCH}`);
		});
		const folder = foldersUpTo('0016_deposit_received_via_payment');
		await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: folder }));
		rmSync(folder, { recursive: true, force: true });
		await withClient(scratch(), async (c) => {
			await c.query(`insert into users (id, phone, name, password_hash, status) values ($1, '+22670555171', 'Directrice', 'x', 'active')`, [
				user
			]);
			await inOrganization(c, agency, () =>
				c.query(
					`insert into organizations (id, type, legal_name, phone, commune, created_by, receipt_prefix) values ($1, 'agency', 'Agence du lot 09', '+22625300171', 'Ouagadougou', $2, 'AGL')`,
					[agency, user]
				)
			);
			await inOrganization(c, agency, async () => {
				await c.query(
					`insert into owners (id, organization_id, type, name, phone) values ($1, $2, 'person', 'Propriétaire', '+22670555173')`,
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
					`insert into rent_dues (id, organization_id, lease_id, period_start, period_end, due_on, rent, charges, amount_due, status, lease_version)
					 values ($1, $2, $3, '2026-09-01', '2026-09-30', '2026-09-05', 75000, 5000, 80000, 'due', 1)`,
					[due, agency, lease]
				);
				await c.query(
					`insert into payments (id, organization_id, lease_id, purpose, amount, method, paid_on, status, idempotency_key, confirmed_at, confirmed_by)
					 values ($1, $2, $3, 'rent', 80000, 'cash', '2026-09-04', 'confirmed', 'lot09', now(), $4)`,
					[payment, agency, lease, user]
				);
				await c.query(
					`insert into payment_allocations (id, organization_id, payment_id, lease_id, target, rent_due_id, direction, amount)
					 values ($1, $2, $3, $4, 'rent_due', $5, 'allocate', 80000)`,
					[allocation, agency, payment, lease, due]
				);
				await c.query(`insert into receipts (id, organization_id, payment_id, provisional_number) values ($1, $2, $3, 'PROV-ABC171')`, [
					receipt,
					agency,
					payment
				]);
				await c.query(
					`update receipts set status = 'valid', issued_on = '2026-09-04', snapshot = '{"organization":{"name":"Agence"}}' where id = $1`,
					[receipt]
				);
			});
		});
		await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: MIGRATIONS_FOLDER }));
	}, 120_000);
	afterAll(async () => {
		await withClient(serverUrl(), (c) => c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`));
	});

	it('l’encaissement, son imputation et son reçu du lot 09 sont intacts ; l’échéance garde son montant payé', async () => {
		await withClient(scratch(), (c) =>
			inOrganization(
				c,
				agency,
				async () => {
					const p = await c.query(`select purpose, expense_id, amount::int, status from payments where id = $1`, [payment]);
					expect(p.rows).toEqual([{ purpose: 'rent', expense_id: null, amount: 80_000, status: 'confirmed' }]);
					const a = await c.query(`select target, expense_id, amount::int from payment_allocations where id = $1`, [allocation]);
					expect(a.rows).toEqual([{ target: 'rent_due', expense_id: null, amount: 80_000 }]);
					const r = await c.query(`select number, status, purpose from receipts where id = $1`, [receipt]);
					expect(r.rows).toEqual([{ number: 'AGL-2026-000001', status: 'valid', purpose: 'rent' }]);
					const d = await c.query(`select amount_paid::int from rent_dues where id = $1`, [due]);
					expect(d.rows[0].amount_paid).toBe(80_000);
				},
				false
			)
		);
	});

	it('dépense, relance, relevé émis avec l’imputation du lot 09, lien et reversement s’enregistrent', async () => {
		await withClient(scratch(), (c) =>
			inOrganization(
				c,
				agency,
				async () => {
					const expense = await insertExpense(c, agency, { propertyId: property, unitId: unit });
					await insertReminder(c, agency, tenant, { dueIds: [due] });
					const statement = await insertStatement(c, agency, ownerId, '2026-09', { expenses: -15_000 });
					await issueStatement(c, agency, statement, user);
					expect(await insertLine(c, agency, statement, { kind: 'allocation', allocationId: allocation })).toBe(`allocation:${allocation}`);
					await insertLine(c, agency, statement, { kind: 'expense', expenseId: expense });
					await insertStatementToken(c, agency, statement);
					await insertPayout(c, agency, statement, ownerId, 57_500);
					const s = await c.query(`select status, net::int from owner_statements where id = $1`, [statement]);
					expect(s.rows).toEqual([{ status: 'issued', net: 57_500 }]);
				},
				false
			)
		);
	});

	it('les migrations se rejouent sans erreur ni doublon', async () => {
		await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: MIGRATIONS_FOLDER }));
		const tables = await withClient(scratch(), (c) =>
			c.query(`select count(*)::int as n from pg_tables where tablename in ('reminders', 'expenses', 'owner_statements', 'owner_payouts')`)
		);
		expect(tables.rows[0].n).toBe(4);
		const published = await withClient(scratch(), (c) =>
			c.query(`select count(*)::int as n from pg_publication_tables where pubname = 'powersync' and tablename = 'owner_statements'`)
		);
		expect(published.rows[0].n).toBe(1);
	});
});
